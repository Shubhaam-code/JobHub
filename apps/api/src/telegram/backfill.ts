/**
 * Startup backfill: imports the last N days of channel history through the
 * EXACT SAME ingestion pipeline as live messages (normalize → sanitize → dedupe
 * → durable queue). There is no second parsing path, so a backfilled post and a
 * live post are treated identically.
 *
 * The window is date-driven: history is walked newest → oldest and the walk
 * stops at the first message older than the cutoff, so the whole channel is
 * never fetched. The collected messages are then ingested oldest → newest.
 *
 * Only the id, date and text of each message are kept while walking — never the
 * GramJS message object, which carries the peer, media and entity graph behind
 * it. With 17 channels backfilled in sequence at startup, holding the raw
 * objects instead would multiply the startup peak by the size of that graph.
 *
 * Safe to run repeatedly: deduplication stays the ingestion pipeline's job via
 * the queue's unique message key.
 */

import { errors } from 'telegram';
import type { Api, TelegramClient } from 'telegram';

import { logger } from '../lib/logger.js';
import { ingestMessage, type IngestionInput, type IngestionResult } from './ingestion.js';

/** How far back the startup backfill reaches. */
export const BACKFILL_WINDOW_DAYS = 7;

const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Defensive ceiling on how many messages one backfill may walk. The date cutoff
 * is the real stop condition; this only bounds a pathological channel (or a
 * skewed clock) and is logged loudly when it triggers. It is also handed to
 * GramJS, which otherwise treats an absent limit as "the entire channel".
 *
 * Overridable per run (`maxMessages`) because the ceiling has to scale with the
 * window: a 14-day recovery on a busy channel can exceed what 7 days needed, and
 * hitting this before the cutoff means part of the window is silently missing.
 * `truncated` in the summary is what reports that.
 */
export const MAX_MESSAGES_WALKED = 1_000;

/** The slice of the GramJS client this module needs (keeps it unit-testable). */
export type MessageHistorySource = Pick<TelegramClient, 'iterMessages'>;

export interface BackfillSummary {
  /** Messages read from Telegram, including the one that crossed the cutoff. */
  fetched: number;
  /** Of those, the ones dated within the window. */
  eligible: number;
  /** Messages added to the ingest queue by this run. */
  queued: number;
  duplicates: number;
  skipped: number;
  errors: number;
  /** Oldest Telegram date this backfill accepted. */
  cutoff: Date;
  /** Set when Telegram rate-limited the walk; the walk stopped, no retry. */
  floodWaitSeconds?: number;
  /** Set when the walk failed before reaching the cutoff. */
  fetchError?: string;
  /** True when MAX_MESSAGES_WALKED stopped the walk before the cutoff. */
  truncated: boolean;
}

export interface BackfillOptions {
  client: MessageHistorySource;
  /** Already-resolved target channel. */
  entity: Api.Channel;
  /** Channel username — the dedup key and message-URL base. */
  channelUsername: string;
  /** Numeric channel ID, when known. Makes the dedup key rename-proof. */
  channelId?: string | null;
  /** Window size in days. Defaults to BACKFILL_WINDOW_DAYS. */
  windowDays?: number;
  /** Walk ceiling for this run. Defaults to MAX_MESSAGES_WALKED. */
  maxMessages?: number;
  /** Reference clock in ms; the cutoff derives from it. Injected by tests. */
  now?: number;
  /** Ingestion entry point. Overridden only in tests. */
  ingest?: (input: IngestionInput) => Promise<IngestionResult>;
}

/** Only the message fields the ingestion pipeline needs. */
interface HistoryMessage {
  id: number;
  /** Unix seconds, as sent by Telegram — the source of truth for the cutoff. */
  date: number;
  /** Message body or media caption; '' when the post carries neither. */
  text: string;
}

/**
 * Narrows a value yielded by `iterMessages` (typed `any` by GramJS) to the
 * fields used here. Returns null for anything without a usable id and date,
 * e.g. service messages.
 */
function toHistoryMessage(raw: unknown): HistoryMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const candidate = raw as { id?: unknown; date?: unknown; message?: unknown };

  if (typeof candidate.id !== 'number' || typeof candidate.date !== 'number') {
    return null;
  }

  return {
    id: candidate.id,
    date: candidate.date,
    // Media posts carry their text in the same `message` field as a caption.
    text: typeof candidate.message === 'string' ? candidate.message : '',
  };
}

/**
 * Imports every eligible message from the last `windowDays` days.
 *
 * Never throws: Telegram-side failures stop the walk and are reported in the
 * summary, and a single bad message can only bump a counter.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillSummary> {
  const windowDays = options.windowDays ?? BACKFILL_WINDOW_DAYS;
  const maxMessages = options.maxMessages ?? MAX_MESSAGES_WALKED;
  const ingest = options.ingest ?? ingestMessage;

  // The cutoff is computed once, when the backfill starts.
  const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);
  const cutoffSeconds = nowSeconds - windowDays * SECONDS_PER_DAY;

  const summary: BackfillSummary = {
    fetched: 0,
    eligible: 0,
    queued: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    cutoff: new Date(cutoffSeconds * 1000),
    truncated: false,
  };

  logger.info(
    `[backfill] Starting ${windowDays}-day Telegram backfill ` +
      `(cutoff ${summary.cutoff.toISOString()})...`,
  );

  // ── Walk history newest → oldest, stopping at the cutoff ──────────────────
  const eligible: HistoryMessage[] = [];
  let reachedCutoff = false;

  try {
    // The date cutoff below is what normally ends the walk; the ceiling is only a
    // backstop, since GramJS reads the whole channel when `limit` is absent.
    // Either way only the recent chunks of history are requested.
    for await (const raw of options.client.iterMessages(options.entity, {
      limit: maxMessages,
    })) {
      summary.fetched += 1;

      const message = toHistoryMessage(raw);

      if (message === null) {
        summary.skipped += 1;
        logger.debug('[backfill] Skipped an entry with no usable id/date.');
        continue;
      }

      // Telegram returns history newest-first, so the first message older than
      // the cutoff means everything after it is older too.
      if (message.date < cutoffSeconds) {
        reachedCutoff = true;
        logger.debug(`[backfill] msg ${message.id} predates the cutoff — stopping the walk.`);
        break;
      }

      eligible.push(message);
    }
  } catch (error: unknown) {
    if (error instanceof errors.FloodWaitError) {
      summary.floodWaitSeconds = error.seconds;
      logger.warn(
        `[backfill] FLOOD_WAIT: Telegram wants ${error.seconds}s — stopping the walk, not retrying.`,
      );
    } else {
      summary.fetchError = error instanceof Error ? error.message : String(error);
      summary.errors += 1;
      logger.error(`[backfill] History walk failed: ${summary.fetchError}`);
    }
    // Whatever was collected before the failure is still worth ingesting.
  }

  // Hitting the ceiling before the cutoff means part of the window was missed.
  if (!reachedCutoff && summary.fetched >= maxMessages) {
    summary.truncated = true;
    logger.warn(
      `[backfill] Stopped after ${maxMessages} messages without reaching the ` +
        `${windowDays}-day cutoff — older posts inside the window were NOT imported.`,
    );
  }

  summary.eligible = eligible.length;

  if (eligible.length === 0) {
    logger.info(`[backfill] Nothing to backfill — no messages in the last ${windowDays} days.`);
    return summary;
  }

  // ── Ingest oldest → newest ────────────────────────────────────────────────
  /* Walked newest-first, so the buffer is drained from the back to ingest in
     chronological order. `pop()` (rather than `reverse()` then `for…of`) also
     releases each message as it is consumed, so the post text already ingested
     is collectable while the rest of the window is still being queued, instead
     of the whole window staying reachable until the loop ends. */
  while (eligible.length > 0) {
    const message = eligible.pop();
    if (message === undefined) break;

    try {
      const result = await ingest({
        text: message.text,
        messageId: message.id,
        date: message.date,
        channelUsername: options.channelUsername,
        channelId: options.channelId ?? null,
      });

      switch (result.outcome) {
        case 'queued':
          summary.queued += 1;
          break;
        case 'duplicate':
          summary.duplicates += 1;
          break;
        case 'skipped':
          summary.skipped += 1;
          break;
        case 'error':
          summary.errors += 1;
          break;
      }
    } catch (error: unknown) {
      // The pipeline reports its own failures, so reaching here is unexpected —
      // count it and keep going rather than abandoning the rest of the window.
      summary.errors += 1;
      const reason = error instanceof Error ? error.message : String(error);
      logger.error(`[backfill] msg ${message.id}: unexpected ingestion failure — ${reason}`);
    }
  }

  logger.info(
    `[backfill] Summary — fetched=${summary.fetched}, eligible=${summary.eligible}, ` +
      `queued=${summary.queued}, duplicates=${summary.duplicates}, ` +
      `skipped=${summary.skipped}, errors=${summary.errors}`,
  );

  return summary;
}
