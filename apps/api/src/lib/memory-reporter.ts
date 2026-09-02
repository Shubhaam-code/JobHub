/**
 * Process memory observability.
 *
 * A periodic, single-line snapshot of what this process is holding: RSS, heap,
 * external/ArrayBuffer bytes, how many jobs are in flight, how deep the queue
 * is, and how many peers the Telegram session is caching. That is enough to
 * answer the question an OOM kill never answers on its own — *what* was growing,
 * and *when* it started.
 *
 * Deliberately boring and production-safe:
 *
 * - No message text, prompt, LLM response, resume, filename, email, token or
 *   API key is ever read here, let alone logged. Every value below is a number.
 * - One query per interval (`countClaimable`, an indexed count), default 60s.
 * - The timer is `unref`'d, so it never keeps the process alive during shutdown.
 * - Failures are swallowed: diagnostics must never be able to take the API down.
 */

import { logger } from '../lib/logger.js';
import { countClaimable } from '../queue/ingest-queue.js';

/** Reads the size of the Telegram session's bounded entity store, if attached. */
type EntityCountReader = () => number;

let timer: NodeJS.Timeout | null = null;
let readEntityCount: EntityCountReader | null = null;

/** Jobs currently being processed, incremented/decremented by the queue worker. */
let activeJobs = 0;

/** Cumulative counters since boot. Small integers; they never grow in memory. */
const totals = {
  started: 0,
  completed: 0,
  skipped: 0,
  failed: 0,
  retried: 0,
};

export type JobTotalKey = keyof typeof totals;

/** Called by the worker when it claims a message. */
export function jobStarted(): void {
  activeJobs += 1;
  totals.started += 1;
}

/**
 * Called by the worker when a message leaves the process, whatever the outcome.
 * Always paired with `jobStarted` in a `finally`, so a throw cannot strand the
 * gauge at a value that never comes back down.
 */
export function jobFinished(outcome: Exclude<JobTotalKey, 'started'>): void {
  activeJobs = Math.max(0, activeJobs - 1);
  totals[outcome] += 1;
}

/** Jobs in flight right now. Exported for tests and the health endpoint. */
export function activeJobCount(): number {
  return activeJobs;
}

export interface MemorySnapshot {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  activeJobs: number;
  totals: Readonly<typeof totals>;
}

const toMb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/** Current process memory plus the job counters. Numbers only — safe to expose. */
export function memorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();

  return {
    rssMb: toMb(usage.rss),
    heapUsedMb: toMb(usage.heapUsed),
    heapTotalMb: toMb(usage.heapTotal),
    externalMb: toMb(usage.external),
    arrayBuffersMb: toMb(usage.arrayBuffers),
    activeJobs,
    totals: { ...totals },
  };
}

/**
 * Registers a reader for the Telegram session's entity-store size.
 *
 * The listener is optional and starts after the reporter, so this is wired up
 * when (and only when) Telegram actually comes up. Reading a count keeps the
 * reporter free of any Telegram import cycle — and it never touches a row.
 */
export function trackEntityStore(reader: EntityCountReader | null): void {
  readEntityCount = reader;
}

/**
 * Starts periodic memory logging. Idempotent: calling it twice does not create
 * a second timer, so a re-entrant startup path cannot double-log.
 */
export function startMemoryReporter(intervalMs: number): void {
  if (intervalMs <= 0 || timer !== null) return;

  const tick = (): void => {
    void (async (): Promise<void> => {
      try {
        const snapshot = memorySnapshot();

        // Queue depth comes from the database, not from anything held here —
        // the point of the durable queue is that depth costs no process memory.
        let claimable = -1;
        try {
          claimable = await countClaimable();
        } catch {
          // Mongo reconnecting: report memory anyway, that is the useful half.
        }

        const parts = [
          `rss=${snapshot.rssMb}MB`,
          `heapUsed=${snapshot.heapUsedMb}MB`,
          `heapTotal=${snapshot.heapTotalMb}MB`,
          `external=${snapshot.externalMb}MB`,
          `arrayBuffers=${snapshot.arrayBuffersMb}MB`,
          `activeJobs=${snapshot.activeJobs}`,
          `queueClaimable=${claimable >= 0 ? claimable : 'unknown'}`,
          `started=${snapshot.totals.started}`,
          `completed=${snapshot.totals.completed}`,
          `skipped=${snapshot.totals.skipped}`,
          `retried=${snapshot.totals.retried}`,
          `failed=${snapshot.totals.failed}`,
        ];

        const entities = readEntityCount?.();
        if (entities !== undefined) parts.push(`tgEntities=${entities}`);

        logger.info(`[memory] ${parts.join(' ')}`);
      } catch {
        // Observability must never be able to crash the process it observes.
      }
    })();
  };

  timer = setInterval(tick, intervalMs);
  // Never hold the event loop open — shutdown must not wait on a diagnostic.
  timer.unref?.();

  logger.info(`[memory] reporter started interval=${intervalMs}ms`);
}

/** Stops the reporter and releases the entity-store reader. */
export function stopMemoryReporter(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
  readEntityCount = null;
}
