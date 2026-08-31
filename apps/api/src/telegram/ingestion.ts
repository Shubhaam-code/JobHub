/**
 * Per-message ingestion — the half that runs at Telegram's pace.
 *
 * Telegram → normalize + sanitize → deduplicate → persistent queue
 *
 * Deliberately free of LLM calls. The listener used to block on classification,
 * so a slow, unavailable or rate-limited provider stalled ingestion and messages
 * could be lost. Now the message is cleaned, its apply URL extracted and the
 * whole thing durably queued in a few milliseconds; the LLM worker drains the
 * queue independently (see `src/queue/worker.ts`).
 *
 * Channel-agnostic: the same path runs for every active channel, so adding a
 * channel needs no code change.
 */

import { logger } from '../lib/logger.js';
import { enqueueMessage } from '../queue/ingest-queue.js';
import { isChannelIngestionEnabled, recordChannelActivity } from './channel-registry.js';
import { classifyJobPost, type ClassifiedJob } from './job-classifier.js';
import { prefilterMessage } from './job-prefilter.js';
import { validateClassifiedJob } from './job-validator.js';
import { normalizeMessage } from './normalize.js';

export type IngestionOutcome = 'queued' | 'duplicate' | 'skipped' | 'error';

export interface IngestionInput {
  text: string;
  messageId: number;
  /** Unix timestamp (seconds) from Telegram. */
  date: number;
  channelUsername: string;
  /** Numeric Telegram channel ID, when the caller has resolved the entity. */
  channelId?: string | null;
}

export interface IngestionResult {
  outcome: IngestionOutcome;
  messageId: number;
  reason?: string;
  /** Queue document id, set when this call enqueued the message. */
  queueJobId?: string;
}

/**
 * Outcome of evaluating one post's text, independent of storage.
 *
 * `not-job` is a decision ("this is promotion"), `unavailable` is the absence of
 * one (no API key, provider error, timeout, unusable output). Keeping them apart
 * matters: a post may only be discarded on a decision, never on a failure.
 */
export type EvaluationResult =
  | { verdict: 'job'; job: ClassifiedJob }
  | { verdict: 'not-job'; reason: string }
  | {
      verdict: 'unavailable';
      reason: string;
      /** Set when the provider returned 429 — the queue should retry. */
      rateLimited?: boolean;
      retryAfterMs?: number;
    };

export interface EvaluateOptions {
  /** Forwarded to the LLM call; the worker passes 1 and owns the retry itself. */
  maxAttempts?: number;
}

function buildMessageUrl(channelUsername: string, messageId: number): string {
  return `https://t.me/${channelUsername}/${messageId}`;
}

/**
 * Runs the classification half of the pipeline: pre-filter, LLM, validation.
 *
 * Shared by the queue worker and the stored-data cleanup so both judge a post by
 * exactly the same rules. Expects text that has already been normalized.
 */
export async function evaluateJobPost(
  text: string,
  options: EvaluateOptions = {},
): Promise<EvaluationResult> {
  if (!text || text.trim().length === 0) {
    return { verdict: 'not-job', reason: 'no text' };
  }

  // 1. Cheap local pre-filter — keeps obvious noise away from the LLM.
  const prefilter = prefilterMessage(text);
  if (!prefilter.send) {
    return { verdict: 'not-job', reason: prefilter.reason ?? 'filtered locally' };
  }

  // 2. LLM classification + extraction (structured JSON, never free-form).
  const classification = await classifyJobPost(
    text,
    options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {},
  );
  if (!classification.ok) {
    // A provider/parse failure is not a verdict — the post stays undecided.
    return {
      verdict: 'unavailable',
      reason: classification.reason,
      ...(classification.rateLimited ? { rateLimited: true } : {}),
      ...(classification.retryAfterMs !== undefined
        ? { retryAfterMs: classification.retryAfterMs }
        : {}),
    };
  }

  // 3. Deterministic validation has the final word.
  const validation = validateClassifiedJob(classification.job);
  if (!validation.valid) {
    return { verdict: 'not-job', reason: validation.reason ?? 'failed validation' };
  }

  return { verdict: 'job', job: classification.job };
}

/**
 * Normalizes one Telegram message and puts it on the durable queue.
 *
 * Fast and LLM-free by design: whatever the provider is doing, the message is
 * safely persisted before this returns. Errors are caught per-message so one
 * malformed post cannot crash the listener.
 */
export async function ingestMessage(input: IngestionInput): Promise<IngestionResult> {
  const { text, messageId, date, channelUsername } = input;
  const channelId = input.channelId ?? null;

  // Every log line names its channel so multi-channel activity stays readable.
  const ref = `[@${channelUsername} msg ${messageId}]`;

  try {
    logger.debug(`${ref} telegram message received`);

    // An admin-paused channel stops here: nothing is normalized, queued or
    // classified. Existing jobs and already-queued messages are untouched, so
    // resuming continues exactly where it left off.
    if (!(await isChannelIngestionEnabled(channelUsername))) {
      logger.debug(`${ref} skipped → channel paused`);
      return { outcome: 'skipped', messageId, reason: 'channel paused' };
    }

    if (!text || text.trim().length === 0) {
      logger.debug(`${ref} skipped → no text`);
      return { outcome: 'skipped', messageId, reason: 'no text' };
    }

    // Promotion is stripped and the apply URL captured here, before anything
    // reaches the model or the user-facing text.
    const normalized = normalizeMessage(text);

    if (normalized.cleanedText.trim().length === 0) {
      logger.debug(`${ref} skipped → nothing left after removing promotion`);
      return { outcome: 'skipped', messageId, reason: 'promotion only' };
    }

    logger.debug(
      `${ref} message normalized removedLines=${normalized.removedLines} removedUrls=${normalized.removedUrls.length} applyUrl=${normalized.applyUrl ? 'yes' : 'none'}`,
    );

    const result = await enqueueMessage({
      source: 'telegram',
      telegramChannel: channelUsername,
      telegramChannelId: channelId,
      telegramMessageId: messageId,
      telegramMessageUrl: buildMessageUrl(channelUsername, messageId),
      postedAt: new Date(date * 1000),
      rawMessage: text,
      cleanedText: normalized.cleanedText,
      applyUrl: normalized.applyUrl,
    });

    if (result.outcome === 'duplicate') {
      logger.debug(`${ref} duplicate detected → already queued, ignoring`);
      return { outcome: 'duplicate', messageId };
    }

    // Reporting only — the registry swallows its own errors, so this cannot
    // affect the outcome of an ingest.
    await recordChannelActivity({ username: channelUsername, messageId });

    logger.info(`${ref} job added to queue queueJobId=${result.queueJobId ?? 'unknown'}`);

    return {
      outcome: 'queued',
      messageId,
      ...(result.queueJobId !== null ? { queueJobId: result.queueJobId } : {}),
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${ref} error → ${message}`);
    return { outcome: 'error', messageId, reason: message };
  }
}
