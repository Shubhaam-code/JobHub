/**
 * The durable ingest queue.
 *
 * Backed by the `ingest_queue` MongoDB collection rather than an in-memory
 * array, which is what makes the guarantees real: a message that has been
 * enqueued survives an LLM outage, a rate limit, a crash and a restart. The
 * collection is already there (Mongo is a hard dependency of this service), so
 * no extra infrastructure is introduced.
 *
 * Claiming uses a single atomic `findOneAndUpdate`, so several workers — or two
 * processes during a rolling restart — can never hand the same message to the
 * LLM twice.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  IngestQueueModel,
  type IngestQueueDocument,
  type QueueStatus,
} from '../models/ingest-queue.model.js';

/** Mongo's duplicate-key error. Here it means "already queued", not a failure. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

export interface EnqueueInput {
  source: string;
  telegramChannel: string;
  telegramChannelId: string | null;
  telegramMessageId: number;
  telegramMessageUrl: string | null;
  postedAt: Date;
  rawMessage: string;
  cleanedText: string;
  applyUrl: string | null;
}

export type EnqueueOutcome = 'queued' | 'duplicate';

export interface EnqueueResult {
  outcome: EnqueueOutcome;
  /** The queue document id — present when this call created it. */
  queueJobId: string | null;
}

/**
 * Stable identity for a Telegram message.
 *
 * Prefers the numeric channel ID because a channel can be renamed; falls back to
 * the lowercased username when the ID is not known (usernames are
 * case-insensitive, so "@Jobs" and "jobs" must produce one key).
 */
export function buildMessageKey(
  channelId: string | null,
  channelUsername: string,
  messageId: number,
): string {
  const channelPart = channelId ?? channelUsername.replace(/^@/, '').toLowerCase();
  return `${channelPart}:${messageId}`;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE
  );
}

/**
 * Adds a normalized message to the queue.
 *
 * Deduplication is delegated to the unique indexes: the insert is attempted and
 * a duplicate-key error is read as "already queued". That is race-free, unlike
 * checking for existence first, so live ingestion and a concurrent backfill of
 * the same message settle on exactly one row — and therefore one LLM call.
 */
export async function enqueueMessage(input: EnqueueInput): Promise<EnqueueResult> {
  const messageKey = buildMessageKey(
    input.telegramChannelId,
    input.telegramChannel,
    input.telegramMessageId,
  );

  try {
    const entry = await IngestQueueModel.create({
      messageKey,
      source: input.source,
      telegramChannel: input.telegramChannel,
      telegramChannelId: input.telegramChannelId,
      telegramMessageId: input.telegramMessageId,
      telegramMessageUrl: input.telegramMessageUrl,
      postedAt: input.postedAt,
      rawMessage: input.rawMessage,
      cleanedText: input.cleanedText,
      applyUrl: input.applyUrl,
      status: 'pending',
      attempts: 0,
      receivedAt: new Date(),
    });

    return { outcome: 'queued', queueJobId: entry._id.toString() };
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      return { outcome: 'duplicate', queueJobId: null };
    }
    throw error;
  }
}

/**
 * Atomically claims the oldest claimable message, or returns null when there is
 * nothing to do.
 *
 * Claimable means `pending`, or `retry_wait` whose `nextRetryAt` has passed. The
 * status flip to `processing` happens inside the same operation that selects the
 * document, so two workers cannot claim it.
 */
export async function claimNextMessage(now: Date = new Date()): Promise<IngestQueueDocument | null> {
  return IngestQueueModel.findOneAndUpdate(
    {
      $or: [
        { status: 'pending' },
        { status: 'retry_wait', nextRetryAt: { $lte: now } },
        // A retry_wait row with no due time would otherwise be stranded.
        { status: 'retry_wait', nextRetryAt: null },
      ],
    },
    {
      $set: { status: 'processing', claimedAt: now },
      $inc: { attempts: 1 },
    },
    {
      new: true,
      // Oldest post first, so the queue drains in the order things happened.
      sort: { receivedAt: 1, telegramMessageId: 1 },
    },
  ).exec();
}

/** Marks a claimed message as done. `jobId` is set when a job was stored. */
export async function markCompleted(
  queueJobId: string,
  jobId: string | null = null,
): Promise<void> {
  await IngestQueueModel.updateOne(
    { _id: queueJobId },
    {
      $set: {
        status: 'completed' satisfies QueueStatus,
        processedAt: new Date(),
        nextRetryAt: null,
        claimedAt: null,
        lastError: null,
        ...(jobId !== null ? { jobId } : {}),
      },
    },
  ).exec();
}

/**
 * Exponential backoff with a provider override.
 *
 * `Retry-After` wins whenever the provider supplied one — it knows when its
 * window reopens. Otherwise the delay doubles per attempt from
 * `QUEUE_RETRY_BASE_MS` (5s → 10s → 20s → 40s …) and is capped at
 * `QUEUE_RETRY_MAX_MS`, so a long outage can never schedule a retry days away
 * and repeated failures can never become a tight loop.
 *
 * Pure and exported so the backoff curve is unit-testable.
 */
export function computeRetryDelayMs(
  attempts: number,
  retryAfterMs?: number | null,
  options: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = options.baseMs ?? env.QUEUE_RETRY_BASE_MS;
  const maxMs = options.maxMs ?? env.QUEUE_RETRY_MAX_MS;

  if (retryAfterMs !== undefined && retryAfterMs !== null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, maxMs);
  }

  // attempts is 1-based (already incremented by the claim), so attempt 1 waits baseMs.
  const exponent = Math.max(0, attempts - 1);
  const delay = baseMs * 2 ** Math.min(exponent, 30);

  return Math.min(delay, maxMs);
}

export interface RetryDecision {
  status: Extract<QueueStatus, 'retry_wait' | 'failed'>;
  /** Set only for `retry_wait`. */
  nextRetryAt: Date | null;
  delayMs: number;
}

/**
 * Puts a message back into the queue after a transient failure, or parks it as
 * permanently failed once it has used up `QUEUE_MAX_ATTEMPTS`.
 *
 * The message is never deleted in either case: a `failed` row is the dead-letter
 * record, still holding the raw text, so nothing is lost even when it can never
 * be classified.
 */
export async function scheduleRetry(
  entry: Pick<IngestQueueDocument, 'attempts'> & { _id: unknown },
  reason: string,
  retryAfterMs?: number | null,
  now: Date = new Date(),
): Promise<RetryDecision> {
  const queueJobId = String(entry._id);
  const attempts = entry.attempts;

  if (attempts >= env.QUEUE_MAX_ATTEMPTS) {
    await IngestQueueModel.updateOne(
      { _id: entry._id },
      {
        $set: {
          status: 'failed' satisfies QueueStatus,
          lastError: reason,
          processedAt: now,
          nextRetryAt: null,
          claimedAt: null,
        },
      },
    ).exec();

    logger.warn(
      `[queue] job permanently failed queueJobId=${queueJobId} attempts=${attempts} reason=${reason}`,
    );

    return { status: 'failed', nextRetryAt: null, delayMs: 0 };
  }

  const delayMs = computeRetryDelayMs(attempts, retryAfterMs);
  const nextRetryAt = new Date(now.getTime() + delayMs);

  await IngestQueueModel.updateOne(
    { _id: entry._id },
    {
      $set: {
        status: 'retry_wait' satisfies QueueStatus,
        lastError: reason,
        nextRetryAt,
        claimedAt: null,
      },
    },
  ).exec();

  logger.info(
    `[queue] retry scheduled queueJobId=${queueJobId} attempt=${attempts} delay=${Math.round(delayMs / 1000)}s nextRetryAt=${nextRetryAt.toISOString()}`,
  );

  return { status: 'retry_wait', nextRetryAt, delayMs };
}

/**
 * Returns claims abandoned by a killed worker to `pending`.
 *
 * Run at startup, which is what makes "pending jobs are recoverable after a
 * restart" true for messages that were mid-flight when the process died: their
 * `processing` row would otherwise never be claimed again.
 */
export async function recoverStaleClaims(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.QUEUE_STALE_CLAIM_MS);

  const result = await IngestQueueModel.updateMany(
    {
      status: 'processing',
      $or: [{ claimedAt: { $lte: cutoff } }, { claimedAt: null }],
    },
    {
      $set: { status: 'pending' satisfies QueueStatus, claimedAt: null },
    },
  ).exec();

  if (result.modifiedCount > 0) {
    logger.info(`[queue] recovered ${result.modifiedCount} stale processing job(s) to pending`);
  }

  return result.modifiedCount;
}

export type QueueCounts = Record<QueueStatus, number> & { total: number };

/** Count per status. Used by `npm run queue:status` and by startup logging. */
export async function getQueueCounts(): Promise<QueueCounts> {
  const rows = await IngestQueueModel.aggregate<{ _id: QueueStatus; count: number }>([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]).exec();

  const counts: QueueCounts = {
    pending: 0,
    processing: 0,
    completed: 0,
    retry_wait: 0,
    failed: 0,
    total: 0,
  };

  for (const row of rows) {
    if (row._id in counts) counts[row._id] = row.count;
    counts.total += row.count;
  }

  return counts;
}

/** Messages waiting for a worker right now (pending + due retries). */
export async function countClaimable(now: Date = new Date()): Promise<number> {
  return IngestQueueModel.countDocuments({
    $or: [
      { status: 'pending' },
      { status: 'retry_wait', nextRetryAt: { $lte: now } },
      { status: 'retry_wait', nextRetryAt: null },
    ],
  }).exec();
}
