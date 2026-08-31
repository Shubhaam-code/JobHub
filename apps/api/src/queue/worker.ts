/**
 * The LLM worker: the half of the pipeline that runs at the provider's pace.
 *
 * queue → claim → LLM classify → store job → broadcast → mark completed
 *
 * It is a loop, not a listener: it claims one message at a time, and a rate limit
 * or provider outage only ever delays work. Nothing is dropped, because the
 * message stays in the queue until it is either classified or has exhausted its
 * attempts (at which point it is parked as `failed`, still holding its raw text).
 *
 * Classification uses `maxAttempts: 1` so a 429 comes straight back instead of
 * sleeping inside the call — the durable queue schedules the retry.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { broadcastNewJob } from '../lib/socket.js';
import { JobModel } from '../models/job.model.js';
import { type IngestQueueDocument } from '../models/ingest-queue.model.js';
import { formatJob, type MongoJobDoc } from '../routes/jobs.route.js';
import { evaluateJobPost } from '../telegram/ingestion.js';
import { claimNextMessage, markCompleted, scheduleRetry } from './ingest-queue.js';

/** Mongo duplicate key: the job already exists, which is success, not failure. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

export type ProcessOutcome = 'completed' | 'skipped' | 'retry_scheduled' | 'failed' | 'idle';

export interface ProcessResult {
  outcome: ProcessOutcome;
  queueJobId?: string;
  reason?: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Classifies one claimed message and stores the resulting job.
 *
 * The apply URL is taken from the queue entry — extracted deterministically from
 * the raw post during normalization — and only falls back to the model's value
 * when normalization found none. That is what guarantees the link a user clicks
 * is the link the channel published: the LLM cannot shorten, rewrite or invent it.
 */
async function processEntry(entry: IngestQueueDocument): Promise<ProcessResult> {
  const queueJobId = entry._id.toString();
  const ref = `[@${entry.telegramChannel} msg ${entry.telegramMessageId} queueJobId=${queueJobId} attempt=${entry.attempts}]`;

  logger.debug(`${ref} llm request started`);

  // The model reads cleaned text, so promotion cannot influence the verdict, and
  // grounding is checked against exactly what the model saw.
  const evaluation = await evaluateJobPost(entry.cleanedText, { maxAttempts: 1 });

  if (evaluation.verdict === 'unavailable') {
    if (evaluation.rateLimited) {
      logger.warn(
        `${ref} rate limit received${
          evaluation.retryAfterMs !== undefined
            ? ` retryAfter=${Math.round(evaluation.retryAfterMs / 1000)}s`
            : ''
        }`,
      );
    } else {
      logger.warn(`${ref} llm unavailable → ${evaluation.reason}`);
    }

    const decision = await scheduleRetry(entry, evaluation.reason, evaluation.retryAfterMs ?? null);

    return {
      outcome: decision.status === 'failed' ? 'failed' : 'retry_scheduled',
      queueJobId,
      reason: evaluation.reason,
    };
  }

  logger.debug(`${ref} llm success`);

  if (evaluation.verdict === 'not-job') {
    // A decision, not a failure: the message is done with, and the row stays as
    // an audit record of why nothing was stored.
    await markCompleted(queueJobId);
    logger.debug(`${ref} job completed → not a job (${evaluation.reason})`);
    return { outcome: 'skipped', queueJobId, reason: evaluation.reason };
  }

  const { job } = evaluation;

  try {
    const created = await JobModel.create({
      company: job.company,
      role: job.role,
      batch: job.batch,
      // Deterministic extraction wins; the model's URL is only a fallback.
      applyUrl: entry.applyUrl ?? job.applyUrl,
      location: job.location,
      employmentType: job.employmentType,
      source: entry.source,
      telegramChannel: entry.telegramChannel,
      telegramChannelId: entry.telegramChannelId,
      telegramMessageId: entry.telegramMessageId,
      telegramMessageUrl: entry.telegramMessageUrl,
      originalText: entry.rawMessage,
      cleanedText: entry.cleanedText,
      postedAt: entry.postedAt,
    });

    const publicJob = formatJob(created.toObject() as unknown as MongoJobDoc);

    // Live update for anyone with the page open — no manual refresh.
    broadcastNewJob(publicJob);
    await markCompleted(queueJobId, created._id.toString());

    logger.info(
      `${ref} job completed → ${job.company ?? '(no company)'} / ${job.role ?? '(no role)'}`,
    );

    return { outcome: 'completed', queueJobId };
  } catch (error: unknown) {
    if (isDuplicateKeyError(error)) {
      // The job was already stored (e.g. by a pre-queue run). Idempotent.
      await markCompleted(queueJobId);
      logger.debug(`${ref} job completed → already stored (duplicate)`);
      return { outcome: 'skipped', queueJobId, reason: 'duplicate job' };
    }

    // A database failure is transient: retry rather than lose the message.
    const reason = errorText(error);
    logger.error(`${ref} store failed → ${reason}`);
    const decision = await scheduleRetry(entry, reason);

    return {
      outcome: decision.status === 'failed' ? 'failed' : 'retry_scheduled',
      queueJobId,
      reason,
    };
  }
}

/**
 * Claims and processes at most one message.
 *
 * Exported so a script or a test can step the queue by hand without running the
 * loop. Returns `idle` when there is nothing claimable.
 */
export async function processNextMessage(): Promise<ProcessResult> {
  const entry = await claimNextMessage();
  if (entry === null) return { outcome: 'idle' };

  try {
    return await processEntry(entry);
  } catch (error: unknown) {
    // Last-resort guard: an unexpected throw must not leave the row `processing`.
    const reason = errorText(error);
    logger.error(`[queue] unexpected worker error queueJobId=${entry._id.toString()} → ${reason}`);
    const decision = await scheduleRetry(entry, reason);
    return {
      outcome: decision.status === 'failed' ? 'failed' : 'retry_scheduled',
      queueJobId: entry._id.toString(),
      reason,
    };
  }
}

export interface QueueWorker {
  /** Stops after the in-flight message finishes. */
  stop: () => Promise<void>;
}

/**
 * Starts the worker loop.
 *
 * Drains the queue until it is empty, then waits `QUEUE_POLL_INTERVAL_MS` before
 * looking again — one timer, no busy-wait. `LLM_CONCURRENCY` is enforced inside
 * the rate limiter, so this loop stays a simple single-claim cycle.
 */
export function startQueueWorker(): QueueWorker {
  let running = true;
  let wake: (() => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  /** Sleeps, but returns early when `stop()` is called. */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      wake = resolve;
      timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      timer.unref?.();
    });
  }

  async function loop(): Promise<void> {
    logger.info(
      `[queue] worker started pollInterval=${env.QUEUE_POLL_INTERVAL_MS}ms maxAttempts=${env.QUEUE_MAX_ATTEMPTS} rpm=${env.LLM_MAX_REQUESTS_PER_MINUTE} concurrency=${env.LLM_CONCURRENCY}`,
    );

    while (running) {
      let result: ProcessResult;

      try {
        result = await processNextMessage();
      } catch (error: unknown) {
        // Covers the queue itself being unreachable (e.g. Mongo reconnecting).
        logger.error(`[queue] worker cycle failed → ${errorText(error)}`);
        result = { outcome: 'idle' };
      }

      if (!running) break;

      // Nothing claimable, or the message just processed went back to retry_wait.
      // Other pending messages are picked up on the next cycle.
      if (result.outcome === 'idle' || result.outcome === 'retry_scheduled') {
        await sleep(env.QUEUE_POLL_INTERVAL_MS);
      }
    }

    logger.info('[queue] worker stopped');
  }

  const idle = loop();

  return {
    async stop(): Promise<void> {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      // Release a pending sleep so the loop can observe `running === false`.
      wake?.();
      wake = null;
      await idle;
    },
  };
}
