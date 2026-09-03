/**
 * The LLM worker: the half of the pipeline that runs at the provider's pace.
 *
 * queue → claim → LLM classify → store job → broadcast → mark completed
 *
 * It is a loop, not a listener: it claims a bounded number of messages at a
 * time, and a rate limit or provider outage only ever delays work. Nothing is
 * dropped, because the message stays in the queue until it is either classified
 * or has exhausted its attempts (at which point it is parked as `failed`, still
 * holding its raw text).
 *
 * Memory backpressure lives here. The queue itself is in MongoDB, so a backlog
 * of ten thousand messages costs this process nothing; at most
 * `QUEUE_CONCURRENCY` claimed messages — and their in-flight LLM
 * request/response — are ever resident. The queue is never read into an array,
 * and there is no `Promise.all` over claimable work.
 *
 * Classification uses `maxAttempts: 1` so a 429 comes straight back instead of
 * sleeping inside the call — the durable queue schedules the retry.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { jobFinished, jobStarted } from '../lib/memory-reporter.js';
import { broadcastNewJob } from '../lib/socket.js';
import { decideIngestApplyUrl } from '../apply-url/ingest-decision.js';
import { findStoredCompanyLogoUrl } from '../models/job.model.js';
import { saveJob } from '../models/job.repository.js';
import { type IngestQueueDocument } from '../models/ingest-queue.model.js';
import { formatJob, type MongoJobDoc } from '../routes/jobs.route.js';
import { findCompanyLogoUrl } from '../telegram/company-logo.js';
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
 * The company's logo for a job about to be stored, or null.
 *
 * Wrapped in its own try/catch, and separate from the `JobModel.create` below, so
 * that this is a decoration on the write rather than part of it: a provider
 * outage, a slow DNS lookup or an unreachable database on the reuse query all end
 * here as `null`, and the job is stored exactly as it would have been before this
 * feature existed.
 *
 * A logo already stored for the same company is preferred over a fresh lookup —
 * one request per company, not one per posting.
 */
async function resolveLogoForCompany(
  company: string | null,
  ref: string,
): Promise<string | null> {
  try {
    const storedLogoUrl = await findStoredCompanyLogoUrl(company).catch(() => null);
    return await findCompanyLogoUrl(company, { storedLogoUrl });
  } catch (error: unknown) {
    logger.debug(`${ref} company logo lookup skipped → ${errorText(error)}`);
    return null;
  }
}

/**
 * Classifies one claimed message and stores the resulting job.
 *
 * The apply URL is taken from the queue entry — extracted deterministically from
 * the raw post during normalization — and only falls back to the model's value
 * when normalization found none. That is what guarantees the link a user clicks
 * is the link the channel published: the LLM cannot shorten, rewrite or invent it.
 *
 * That link then passes through `decideIngestApplyUrl`, which has one rule: the
 * apply field holds a link judged to be the employer's own page or their ATS, or
 * it holds nothing. A direct link — the overwhelming majority — is stored
 * untouched with no request made. An aggregator article is opened once and the
 * real apply link read out of it; when that fails, or the page offers no
 * convincing link, the article is kept as `sourceUrl` provenance and the row is
 * left for review rather than shipping an article as the Apply button.
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

  /* Deterministic extraction wins; the model's URL is only a fallback.

     What that URL becomes is decided by `decideIngestApplyUrl`: a direct link is
     stored as-is, a shortener is resolved first, and an aggregator article is
     opened so the real apply link inside it can be stored instead — with the
     article kept as `sourceUrl` either way.

     When none of that yields a link we can defend, the apply field is left empty
     and the job is stored as `needs_review`. That is the deliberate change from
     the previous behaviour, which fell back to storing the aggregator URL. */
  const postedApplyUrl = entry.applyUrl ?? job.applyUrl;
  const applyDecision = await decideIngestApplyUrl({
    postedUrl: postedApplyUrl,
    company: job.company,
    ref,
  });

  if (applyDecision.applyUrl !== null && applyDecision.applyUrl !== postedApplyUrl) {
    logger.info(`${ref} apply url → ${applyDecision.applyUrl} (${applyDecision.reason})`);
  } else if (applyDecision.applyUrl === null && postedApplyUrl !== null) {
    logger.warn(`${ref} apply url not stored → ${applyDecision.reason}`);
  }

  const companyLogoUrl = await resolveLogoForCompany(job.company, ref);

  try {
    const created = await saveJob({
      company: job.company,
      role: job.role,
      batch: job.batch,
      applyUrl: applyDecision.applyUrl,
      sourceUrl: applyDecision.sourceUrl,
      applyUrlCandidates: applyDecision.candidates,
      location: job.location,
      employmentType: job.employmentType,
      companyLogoUrl,
      source: entry.source,
      telegramChannel: entry.telegramChannel,
      // Absent and null mean the same thing on a job, and `SaveJobInput` asks for
      // the explicit form rather than leaving the distinction to Mongoose.
      telegramChannelId: entry.telegramChannelId ?? null,
      telegramMessageId: entry.telegramMessageId,
      telegramMessageUrl: entry.telegramMessageUrl ?? null,
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

/** Maps an outcome onto the counter the memory reporter tracks. */
function outcomeCounter(outcome: ProcessOutcome): 'completed' | 'skipped' | 'failed' | 'retried' {
  if (outcome === 'completed') return 'completed';
  if (outcome === 'skipped') return 'skipped';
  if (outcome === 'failed') return 'failed';
  return 'retried';
}

/**
 * Claims and processes at most one message.
 *
 * Exported so a script or a test can step the queue by hand without running the
 * loop. Returns `idle` when there is nothing claimable.
 *
 * The claimed document is referenced only inside this call. Once it returns, the
 * raw post text, the cleaned text and the LLM response are all unreachable and
 * collectable — nothing about a processed message is retained between cycles.
 */
export async function processNextMessage(): Promise<ProcessResult> {
  const entry = await claimNextMessage();
  if (entry === null) return { outcome: 'idle' };

  jobStarted();
  let result: ProcessResult | undefined;

  try {
    result = await processEntry(entry);
  } catch (error: unknown) {
    // Last-resort guard: an unexpected throw must not leave the row `processing`.
    const reason = errorText(error);
    logger.error(`[queue] unexpected worker error queueJobId=${entry._id.toString()} → ${reason}`);

    try {
      const decision = await scheduleRetry(entry, reason);
      result = {
        outcome: decision.status === 'failed' ? 'failed' : 'retry_scheduled',
        queueJobId: entry._id.toString(),
        reason,
      };
    } catch (retryError: unknown) {
      /* Even the retry write failed — the database is unreachable. The row stays
         `processing` and `recoverStaleClaims()` releases it after
         QUEUE_STALE_CLAIM_MS, so the message is delayed, never lost. Reported as
         a retry so the loop backs off instead of spinning on a dead database. */
      logger.error(`[queue] could not schedule retry → ${errorText(retryError)}`);
      result = { outcome: 'retry_scheduled', queueJobId: entry._id.toString(), reason };
    }
  } finally {
    // In a `finally` so the in-flight gauge always comes back down, even on a
    // throw that escaped every handler above.
    jobFinished(outcomeCounter(result?.outcome ?? 'failed'));
  }

  return result;
}

export interface QueueWorker {
  /** Stops after the in-flight message finishes. */
  stop: () => Promise<void>;
}

/**
 * The worker running in this process, if any.
 *
 * A second `startQueueWorker()` returns this one instead of starting another set
 * of runners. Duplicate workers are the classic way a "memory leak" appears
 * after a restart or a hot reload: the old loops keep claiming and processing
 * while the new ones do the same, doubling both memory and provider usage with
 * nothing in the logs to say so. `stop()` clears it, so a stopped worker can be
 * started again.
 */
let activeWorker: QueueWorker | null = null;

/**
 * Starts the worker loop.
 *
 * Runs `QUEUE_CONCURRENCY` independent runners. Each one claims at most one
 * message at a time, so the number of messages resident in this process is
 * capped by that setting and by nothing else — a queue of any depth is drained
 * with the same memory footprint. Claiming is a single atomic `findOneAndUpdate`,
 * so runners can never claim the same row.
 *
 * A runner that finds nothing (or that just parked its message for retry) waits
 * `QUEUE_POLL_INTERVAL_MS` before looking again — one timer per idle runner, no
 * busy-wait. `LLM_CONCURRENCY` is enforced separately inside the rate limiter,
 * which is what keeps provider usage bounded independently of this setting.
 */
export function startQueueWorker(): QueueWorker {
  if (activeWorker !== null) {
    logger.warn('[queue] worker already running in this process — reusing it.');
    return activeWorker;
  }

  let running = true;
  /** One wake handle per sleeping runner, so `stop()` can release all of them. */
  const sleepers = new Map<number, { wake: () => void; timer: NodeJS.Timeout }>();

  /** Sleeps, but returns early when `stop()` is called. */
  function sleep(runnerId: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sleepers.delete(runnerId);
        resolve();
      }, ms);
      timer.unref?.();
      sleepers.set(runnerId, {
        wake: () => {
          sleepers.delete(runnerId);
          resolve();
        },
        timer,
      });
    });
  }

  async function runner(runnerId: number): Promise<void> {
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
        await sleep(runnerId, env.QUEUE_POLL_INTERVAL_MS);
      }
    }
  }

  async function loop(): Promise<void> {
    const concurrency = env.QUEUE_CONCURRENCY;

    logger.info(
      `[queue] worker started concurrency=${concurrency} pollInterval=${env.QUEUE_POLL_INTERVAL_MS}ms maxAttempts=${env.QUEUE_MAX_ATTEMPTS} rpm=${env.LLM_MAX_REQUESTS_PER_MINUTE} llmConcurrency=${env.LLM_CONCURRENCY}`,
    );

    /* `allSettled`, not `all`: this awaits a fixed, small set of long-lived
       runners (not per-message work), and one runner rejecting must not leave
       the others unawaited and un-stoppable during shutdown. */
    await Promise.allSettled(
      Array.from({ length: concurrency }, (_unused, index) => runner(index)),
    );

    logger.info('[queue] worker stopped');
  }

  const idle = loop();

  const worker: QueueWorker = {
    async stop(): Promise<void> {
      running = false;

      // Release every pending sleep so each runner can observe `running === false`.
      for (const sleeper of [...sleepers.values()]) {
        clearTimeout(sleeper.timer);
        sleeper.wake();
      }
      sleepers.clear();

      await idle;

      // Cleared last, so a restart after a clean stop is allowed while a second
      // concurrent start is still refused.
      if (activeWorker === worker) activeWorker = null;
    },
  };

  activeWorker = worker;
  return worker;
}
