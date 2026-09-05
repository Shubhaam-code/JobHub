/**
 * Apply Discovery Queue Operations
 *
 * Atomic operations for enqueueing, claiming, and updating apply discovery jobs.
 * Similar pattern to ingest-queue but focused on apply URL verification.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  ApplyDiscoveryQueueModel,
  type ApplyDiscoveryQueueDocument,
  type DiscoveryStatus,
} from '../models/apply-discovery-queue.model.js';
import { type ApplyUrlCandidate } from '../apply-url/status.js';

/** Mongo's duplicate-key error code. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

export interface EnqueueDiscoveryInput {
  jobId: string;
  company: string | null;
  role: string | null;
  location: string | null;
  employmentType: string | null;
  batch: string | null;
  sourceUrl: string | null;
  initialApplyUrl: string | null;
  initialCandidates?: ApplyUrlCandidate[] | null;
}

export type EnqueueDiscoveryOutcome = 'queued' | 'updated' | 'duplicate';

export interface EnqueueDiscoveryResult {
  outcome: EnqueueDiscoveryOutcome;
  discoveryJobId: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE
  );
}

/** The context fields a re-enqueue refreshes on an existing row. */
function discoveryContext(input: EnqueueDiscoveryInput): Record<string, unknown> {
  return {
    company: input.company,
    role: input.role,
    location: input.location,
    employmentType: input.employmentType,
    batch: input.batch,
    sourceUrl: input.sourceUrl,
    initialApplyUrl: input.initialApplyUrl,
    initialCandidates: input.initialCandidates ?? null,
  };
}

/**
 * Enqueues apply discovery for a saved job — at most one row per job, ever.
 *
 * One row per `jobId` is the invariant the whole cost story rests on: a second row
 * for the same job is a second Firecrawl scrape and a second web search for an
 * answer the first row already has. So the write is a single atomic upsert keyed on
 * `jobId` rather than a create that falls back to an update. That distinction
 * matters because the unique index is a safety net, not the mechanism — a database
 * whose `{ jobId: 1 }` index was built without `unique: true` (Mongo will not
 * rebuild an existing index just because the schema's options changed) silently
 * turned every create into a new row. An upsert holds regardless.
 *
 * Two existing rows are deliberately left alone rather than reset:
 *
 *   - `processing`: a worker holds this row right now. Resetting `attempts` and
 *     `status` under it would let a second worker claim the same job, so both pay
 *     for the same discovery. The claim is left to finish; stale claims are already
 *     recovered by `recoverStaleDiscoveryClaims`.
 *   - `completed` with `verified: true`: the answer is known and stored on the job.
 *     Re-running discovery cannot improve it and would re-bill it.
 *
 * Everything else — `pending`, `retry_wait`, `not_found`, `failed`, and a
 * `completed` row that never verified — is reset to `pending` with fresh context,
 * which is what gives a job another attempt after an escalation stage is enabled.
 * `attempts` returns to 0 by design: the bounded budget is per discovery campaign,
 * and a deliberate re-enqueue starts a new one. Retry backoff itself is untouched,
 * so no loop is introduced.
 */
export async function enqueueDiscoveryJob(
  input: EnqueueDiscoveryInput,
): Promise<EnqueueDiscoveryResult> {
  /* Read before writing so an in-flight claim and an already-verified result can be
     told apart from a row that should be retried. This is not a lock: the upsert
     below is the atomic step, and the unique index is what settles a true race. */
  const existing = await ApplyDiscoveryQueueModel.findOne({ jobId: input.jobId })
    .select({ status: 1, verified: 1 })
    .lean<{ _id: unknown; status?: DiscoveryStatus; verified?: boolean } | null>();

  if (existing !== null) {
    const holdsClaim = existing.status === 'processing';
    const alreadyAnswered = existing.status === 'completed' && existing.verified === true;

    if (holdsClaim || alreadyAnswered) {
      logger.debug(
        `[apply-discovery] left as-is jobId=${input.jobId} status=${existing.status ?? '(none)'}`,
      );

      return { outcome: 'duplicate', discoveryJobId: String(existing._id) };
    }
  }

  try {
    const entry = await ApplyDiscoveryQueueModel.findOneAndUpdate(
      { jobId: input.jobId },
      {
        $set: {
          ...discoveryContext(input),
          status: 'pending' satisfies DiscoveryStatus,
          attempts: 0,
          enqueuedAt: new Date(),
          claimedAt: null,
          nextRetryAt: null,
          lastError: null,
        },
        $setOnInsert: { jobId: input.jobId },
      },
      { new: true, upsert: true, includeResultMetadata: true },
    ).exec();

    const created = entry.lastErrorObject?.updatedExisting !== true;
    const discoveryJobId = String(entry.value?._id ?? '');

    logger.debug(
      `[apply-discovery] ${created ? 'queued' : 'updated'} jobId=${input.jobId} ` +
        `company=${input.company ?? '(none)'}`,
    );

    return { outcome: created ? 'queued' : 'updated', discoveryJobId };
  } catch (error: unknown) {
    /* Two enqueues for the same new job raced: both saw no row, both tried to
       insert, and the unique index rejected the loser. The winner's row is the one
       row this job gets, which is the outcome that was wanted — report it as a
       duplicate rather than resetting what the winner just queued. */
    if (isDuplicateKeyError(error)) {
      const winner = await ApplyDiscoveryQueueModel.findOne({ jobId: input.jobId })
        .select({ _id: 1 })
        .lean<{ _id: unknown } | null>();

      if (winner === null) {
        throw new Error(`Failed to resolve existing discovery job for jobId=${input.jobId}`);
      }

      logger.debug(`[apply-discovery] lost enqueue race, reusing jobId=${input.jobId}`);

      return { outcome: 'duplicate', discoveryJobId: String(winner._id) };
    }

    throw error;
  }
}

/**
 * Atomically claims the oldest pending discovery job.
 *
 * Claimable means:
 * - status is `pending`, OR
 * - status is `retry_wait` and nextRetryAt has passed
 *
 * Returns null when there is nothing to claim.
 */
export async function claimNextDiscoveryJob(
  now: Date = new Date(),
): Promise<ApplyDiscoveryQueueDocument | null> {
  return ApplyDiscoveryQueueModel.findOneAndUpdate(
    {
      $or: [
        { status: 'pending' },
        { status: 'retry_wait', nextRetryAt: { $lte: now } },
        { status: 'retry_wait', nextRetryAt: null },
      ],
    },
    {
      $set: { status: 'processing', claimedAt: now },
      $inc: { attempts: 1 },
    },
    {
      new: true,
      sort: { enqueuedAt: 1 },
    },
  ).exec();
}

export interface DiscoveryCompletedInput {
  discoveredApplyUrl: string | null;
  verified: boolean;
  discoveryMethod: string;
  verificationEvidence: object | null;
  candidates: ApplyUrlCandidate[] | null;
  usedFirecrawl: boolean;
  usedWebSearch: boolean;
  externalApiCalls: number;
  reason: string;
}

/**
 * Marks a discovery job as completed (either verified or not_found).
 */
export async function markDiscoveryCompleted(
  discoveryJobId: string,
  result: DiscoveryCompletedInput,
): Promise<void> {
  const status: DiscoveryStatus = result.verified ? 'completed' : 'not_found';

  await ApplyDiscoveryQueueModel.updateOne(
    { _id: discoveryJobId },
    {
      $set: {
        status,
        discoveredApplyUrl: result.discoveredApplyUrl,
        verified: result.verified,
        discoveryMethod: result.discoveryMethod,
        verificationEvidence: result.verificationEvidence,
        candidates: result.candidates,
        usedFirecrawl: result.usedFirecrawl,
        usedWebSearch: result.usedWebSearch,
        externalApiCalls: result.externalApiCalls,
        reason: result.reason,
        completedAt: new Date(),
        claimedAt: null,
        nextRetryAt: null,
        lastError: null,
      },
    },
  ).exec();

  logger.info(
    `[apply-discovery] ${status} discoveryJobId=${discoveryJobId} verified=${result.verified} method=${result.discoveryMethod}`,
  );
}

export interface DiscoveryRetryDecision {
  status: Extract<DiscoveryStatus, 'retry_wait' | 'failed'>;
  nextRetryAt: Date | null;
  delayMs: number;
}

/**
 * Exponential backoff for discovery retries.
 */
function computeDiscoveryRetryDelayMs(
  attempts: number,
  options: { baseMs?: number; maxMs?: number } = {},
): number {
  const baseMs = options.baseMs ?? env.QUEUE_RETRY_BASE_MS;
  const maxMs = options.maxMs ?? env.QUEUE_RETRY_MAX_MS;

  const exponent = Math.max(0, attempts - 1);
  const delay = baseMs * 2 ** Math.min(exponent, 30);

  return Math.min(delay, maxMs);
}

/**
 * Schedules a retry or marks as permanently failed.
 */
export async function scheduleDiscoveryRetry(
  entry: Pick<ApplyDiscoveryQueueDocument, 'attempts' | '_id'>,
  reason: string,
  now: Date = new Date(),
): Promise<DiscoveryRetryDecision> {
  const discoveryJobId = String(entry._id);
  const attempts = entry.attempts;

  if (attempts >= env.QUEUE_MAX_ATTEMPTS) {
    await ApplyDiscoveryQueueModel.updateOne(
      { _id: entry._id },
      {
        $set: {
          status: 'failed' satisfies DiscoveryStatus,
          lastError: reason,
          completedAt: now,
          nextRetryAt: null,
          claimedAt: null,
        },
      },
    ).exec();

    logger.warn(
      `[apply-discovery] permanently failed discoveryJobId=${discoveryJobId} attempts=${attempts} reason=${reason}`,
    );

    return { status: 'failed', nextRetryAt: null, delayMs: 0 };
  }

  const delayMs = computeDiscoveryRetryDelayMs(attempts);
  const nextRetryAt = new Date(now.getTime() + delayMs);

  await ApplyDiscoveryQueueModel.updateOne(
    { _id: entry._id },
    {
      $set: {
        status: 'retry_wait' satisfies DiscoveryStatus,
        lastError: reason,
        nextRetryAt,
        claimedAt: null,
      },
    },
  ).exec();

  logger.info(
    `[apply-discovery] retry scheduled discoveryJobId=${discoveryJobId} attempt=${attempts} delay=${Math.round(delayMs / 1000)}s`,
  );

  return { status: 'retry_wait', nextRetryAt, delayMs };
}

/**
 * Recovers stale processing claims at startup.
 */
export async function recoverStaleDiscoveryClaims(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.QUEUE_STALE_CLAIM_MS);

  const result = await ApplyDiscoveryQueueModel.updateMany(
    {
      status: 'processing',
      $or: [{ claimedAt: { $lte: cutoff } }, { claimedAt: null }],
    },
    {
      $set: { status: 'pending' satisfies DiscoveryStatus, claimedAt: null },
    },
  ).exec();

  if (result.modifiedCount > 0) {
    logger.info(
      `[apply-discovery] recovered ${result.modifiedCount} stale processing job(s) to pending`,
    );
  }

  return result.modifiedCount;
}

export type DiscoveryQueueCounts = Record<DiscoveryStatus, number> & { total: number };

/**
 * Count per status for monitoring and diagnostics.
 */
export async function getDiscoveryQueueCounts(): Promise<DiscoveryQueueCounts> {
  const rows = await ApplyDiscoveryQueueModel.aggregate<{
    _id: DiscoveryStatus;
    count: number;
  }>([{ $group: { _id: '$status', count: { $sum: 1 } } }]).exec();

  const counts: DiscoveryQueueCounts = {
    pending: 0,
    processing: 0,
    completed: 0,
    not_found: 0,
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

/** One job's current discovery result, as reporting should read it. */
export interface DiscoveryOutcomeSummary {
  status: DiscoveryStatus;
  verified: boolean;
  usedFirecrawl: boolean;
  usedWebSearch: boolean;
  externalApiCalls: number;
  reason: string | null;
}

/**
 * The current discovery row for a job.
 *
 * Sorted newest-first on `enqueuedAt` rather than taken with a bare `findOne`,
 * because `findOne` returns whichever row the index happens to reach first — which,
 * on a database that accumulated duplicates before `{ jobId: 1 }` was unique, is
 * usually the oldest one. Reading a stale row makes a cost report claim zero
 * Firecrawl calls for a job that just paid for two. With the unique index in place
 * there is only one row and the sort is a no-op, so this stays correct either way.
 */
export async function getDiscoveryOutcome(
  jobId: string,
): Promise<DiscoveryOutcomeSummary | null> {
  const row = await ApplyDiscoveryQueueModel.findOne({ jobId })
    .sort({ enqueuedAt: -1, _id: -1 })
    .select({
      status: 1,
      verified: 1,
      usedFirecrawl: 1,
      usedWebSearch: 1,
      externalApiCalls: 1,
      reason: 1,
    })
    .lean<{
      status?: DiscoveryStatus;
      verified?: boolean;
      usedFirecrawl?: boolean;
      usedWebSearch?: boolean;
      externalApiCalls?: number;
      reason?: string | null;
    } | null>();

  if (row === null) return null;

  return {
    status: row.status ?? 'pending',
    verified: row.verified === true,
    usedFirecrawl: row.usedFirecrawl === true,
    usedWebSearch: row.usedWebSearch === true,
    externalApiCalls: row.externalApiCalls ?? 0,
    reason: row.reason ?? null,
  };
}

/**
 * Count of claimable discovery jobs right now.
 */
export async function countClaimableDiscoveryJobs(now: Date = new Date()): Promise<number> {
  return ApplyDiscoveryQueueModel.countDocuments({
    $or: [
      { status: 'pending' },
      { status: 'retry_wait', nextRetryAt: { $lte: now } },
      { status: 'retry_wait', nextRetryAt: null },
    ],
  }).exec();
}
