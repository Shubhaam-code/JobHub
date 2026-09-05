/**
 * Apply Discovery Queue Worker
 *
 * Background service that processes apply URL discovery jobs.
 * Similar pattern to the main ingest worker, but focused on apply URL verification.
 *
 * Flow:
 *   Claim job → Run Universal Agent → Update Job Document → Mark Complete
 *
 * Memory-bounded: processes one job at a time per worker instance.
 * Cost-controlled: respects Firecrawl/web search limits.
 */

import { env } from '../config/env.js';
import { broadcastJobUpdateById } from '../lib/job-broadcast.js';
import { logger } from '../lib/logger.js';
import { updateApplyUrlFields } from '../models/job.repository.js';
import { type ApplyDiscoveryQueueDocument } from '../models/apply-discovery-queue.model.js';
import {
  claimNextDiscoveryJob,
  markDiscoveryCompleted,
  scheduleDiscoveryRetry,
} from './queue.js';
import { discoverApplyUrl } from './universal-agent.js';
import { type JobContext } from './types.js';

export type DiscoveryProcessOutcome =
  | 'completed'
  | 'not_found'
  | 'retry_scheduled'
  | 'failed'
  | 'idle';

export interface DiscoveryProcessResult {
  outcome: DiscoveryProcessOutcome;
  discoveryJobId?: string;
  reason?: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Processes one claimed discovery job.
 *
 * Steps:
 * 1. Run universal discovery agent
 * 2. Update job document with results
 * 3. Mark discovery job as completed
 */
async function processDiscoveryEntry(
  entry: ApplyDiscoveryQueueDocument,
): Promise<DiscoveryProcessResult> {
  const discoveryJobId = entry._id.toString();
  const jobId = entry.jobId.toString();
  const ref = `[jobId=${jobId} discoveryJobId=${discoveryJobId} attempt=${entry.attempts}]`;

  logger.debug(`${ref} discovery started`);

  const context: JobContext = {
    jobId,
    /* A queue row stored before one of these fields existed reads as `undefined`;
       the context treats "not known" as null, which is the same thing here. */
    company: entry.company ?? null,
    role: entry.role ?? null,
    location: entry.location ?? null,
    employmentType: entry.employmentType ?? null,
    batch: entry.batch ?? null,
    sourceUrl: entry.sourceUrl ?? null,
    initialApplyUrl: entry.initialApplyUrl ?? null,
    initialCandidates: entry.initialCandidates,
  };

  try {
    // Run the universal discovery agent.
    const result = await discoverApplyUrl(context, {
      enableFirecrawl: env.APPLY_DISCOVERY_ENABLE_FIRECRAWL,
      enableWebSearch: env.APPLY_DISCOVERY_ENABLE_WEB_SEARCH,
      maxExternalCalls: env.APPLY_DISCOVERY_MAX_EXTERNAL_CALLS,
    });

    logger.debug(
      `${ref} discovery completed: verified=${result.verified} method=${result.discoveryMethod} costs=(firecrawl=${result.costs.usedFirecrawl}, search=${result.costs.usedWebSearch}, calls=${result.costs.externalApiCalls})`,
    );

    /* Written through updateApplyUrlFields() rather than a raw `$set`, so the
       aggregator guard in the repository applies to this path too. `$set` bypasses
       the schema's own path validator, and the discovery agent is the one writer
       that composes a URL from third-party pages — exactly the path that most needs
       the check. It throws on an aggregator URL, which lands in the catch below and
       is retried, so a bad candidate can never be stored. */
    if (result.verified && result.applyUrl) {
      await updateApplyUrlFields(entry.jobId, {
        applyUrl: result.applyUrl,
        applyUrlStatus: 'verified',
        applyUrlCheckedAt: new Date(),
        applyUrlVerified: true,
        applyUrlDiscoveryMethod: result.discoveryMethod,
        applyUrlVerificationEvidence: result.verificationEvidence,
        ...(result.candidates.length > 0 ? { applyUrlCandidates: result.candidates } : {}),
      });

      logger.info(`${ref} job updated with verified apply url: ${result.applyUrl}`);
    } else {
      // No verified URL found - mark as needs review.
      await updateApplyUrlFields(entry.jobId, {
        applyUrlStatus: 'needs_review',
        applyUrlCheckedAt: new Date(),
        applyUrlVerified: false,
        applyUrlDiscoveryMethod: result.discoveryMethod,
        ...(result.candidates.length > 0 ? { applyUrlCandidates: result.candidates } : {}),
      });

      logger.info(
        `${ref} no verified url found, marked for review (candidates=${String(result.candidates.length)})`,
      );
    }

    /* The card is already on screen — a job appears as soon as it is ingested and
       its Apply button resolves later — so the client is told the moment the apply
       state changes. Awaited but never fatal: `broadcastJobUpdateById` swallows its
       own failures, and a missed event only means the user sees the button on their
       next fetch. */
    await broadcastJobUpdateById(entry.jobId);

    // Mark discovery job as completed.
    await markDiscoveryCompleted(discoveryJobId, {
      discoveredApplyUrl: result.applyUrl,
      verified: result.verified,
      discoveryMethod: result.discoveryMethod,
      verificationEvidence: result.verificationEvidence,
      candidates: result.candidates.length > 0 ? result.candidates : null,
      usedFirecrawl: result.costs.usedFirecrawl,
      usedWebSearch: result.costs.usedWebSearch,
      externalApiCalls: result.costs.externalApiCalls,
      reason: result.reason,
    });

    return {
      outcome: result.verified ? 'completed' : 'not_found',
      discoveryJobId,
      reason: result.reason,
    };
  } catch (error: unknown) {
    // Transient errors (DB, network) should be retried.
    const reason = errorText(error);
    logger.error(`${ref} discovery processing failed: ${reason}`);

    const decision = await scheduleDiscoveryRetry(entry, reason);

    return {
      outcome: decision.status === 'failed' ? 'failed' : 'retry_scheduled',
      discoveryJobId,
      reason,
    };
  }
}

/**
 * Claims and processes at most one discovery job.
 *
 * Returns 'idle' when there is nothing claimable.
 */
export async function processNextDiscoveryJob(): Promise<DiscoveryProcessResult> {
  const entry = await claimNextDiscoveryJob();

  if (entry === null) {
    return { outcome: 'idle' };
  }

  let result: DiscoveryProcessResult | undefined;

  try {
    result = await processDiscoveryEntry(entry);
  } catch (error: unknown) {
    // Last-resort guard: unexpected throw must not leave row processing.
    const reason = errorText(error);
    logger.error(
      `[apply-discovery] unexpected worker error discoveryJobId=${entry._id.toString()}: ${reason}`,
    );

    try {
      const decision = await scheduleDiscoveryRetry(entry, reason);
      result = {
        outcome: decision.status === 'failed' ? 'failed' : 'retry_scheduled',
        discoveryJobId: entry._id.toString(),
        reason,
      };
    } catch (retryError: unknown) {
      logger.error(`[apply-discovery] could not schedule retry: ${errorText(retryError)}`);
      result = { outcome: 'retry_scheduled', discoveryJobId: entry._id.toString(), reason };
    }
  }

  return result;
}

export interface ApplyDiscoveryWorker {
  /** Stops after the in-flight job finishes. */
  stop: () => Promise<void>;
}

/**
 * The active worker in this process, if any.
 */
let activeDiscoveryWorker: ApplyDiscoveryWorker | null = null;

/**
 * Starts the apply discovery worker loop.
 *
 * Runs independent workers that claim and process discovery jobs.
 * Memory-bounded: only processes APPLY_DISCOVERY_CONCURRENCY jobs at a time.
 */
export function startApplyDiscoveryWorker(): ApplyDiscoveryWorker {
  if (activeDiscoveryWorker !== null) {
    logger.warn('[apply-discovery] worker already running - reusing it');
    return activeDiscoveryWorker;
  }

  let running = true;
  const sleepers = new Map<number, { wake: () => void; timer: NodeJS.Timeout }>();

  function sleep(workerId: number, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        sleepers.delete(workerId);
        resolve();
      }, ms);
      timer.unref?.();
      sleepers.set(workerId, {
        wake: () => {
          sleepers.delete(workerId);
          resolve();
        },
        timer,
      });
    });
  }

  async function runner(workerId: number): Promise<void> {
    while (running) {
      let result: DiscoveryProcessResult;

      try {
        result = await processNextDiscoveryJob();
      } catch (error: unknown) {
        logger.error(`[apply-discovery] worker cycle failed: ${errorText(error)}`);
        result = { outcome: 'idle' };
      }

      if (!running) break;

      // Nothing claimable or retrying - wait before next claim.
      if (result.outcome === 'idle' || result.outcome === 'retry_scheduled') {
        await sleep(workerId, env.APPLY_DISCOVERY_POLL_INTERVAL_MS);
      }
    }
  }

  async function loop(): Promise<void> {
    const concurrency = env.APPLY_DISCOVERY_CONCURRENCY;

    logger.info(
      `[apply-discovery] worker started concurrency=${concurrency} pollInterval=${env.APPLY_DISCOVERY_POLL_INTERVAL_MS}ms maxAttempts=${env.QUEUE_MAX_ATTEMPTS}`,
    );

    await Promise.allSettled(
      Array.from({ length: concurrency }, (_unused, index) => runner(index)),
    );

    logger.info('[apply-discovery] worker stopped');
  }

  const idle = loop();

  const worker: ApplyDiscoveryWorker = {
    async stop(): Promise<void> {
      running = false;

      // Release all pending sleeps.
      for (const sleeper of [...sleepers.values()]) {
        clearTimeout(sleeper.timer);
        sleeper.wake();
      }
      sleepers.clear();

      await idle;

      if (activeDiscoveryWorker === worker) activeDiscoveryWorker = null;
    },
  };

  activeDiscoveryWorker = worker;
  return worker;
}

/**
 * Returns the active worker, if any.
 */
export function getActiveDiscoveryWorker(): ApplyDiscoveryWorker | null {
  return activeDiscoveryWorker;
}
