/**
 * Apply Discovery Worker - Background Service
 *
 * Continuously processes jobs from the apply-discovery queue to find and verify
 * apply URLs for jobs that don't have them.
 *
 * Run with: npm run apply-discovery:worker
 *
 * This worker:
 * 1. Claims jobs from the apply-discovery queue
 * 2. Runs the Universal Apply Discovery Agent
 * 3. Updates job documents with verified URLs
 * 4. Makes Telegram jobs publicly visible once verified
 *
 * Safe to run multiple instances for parallel processing.
 */

import { connectDatabase, isDatabaseConnected } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { processNextDiscoveryJob } from '../apply-discovery/worker.js';

const POLL_INTERVAL_MS = env.APPLY_DISCOVERY_POLL_INTERVAL_MS;
const CONCURRENCY = env.APPLY_DISCOVERY_CONCURRENCY;

let isShuttingDown = false;
let activeWorkers = 0;

/**
 * Worker loop - continuously processes jobs from the queue
 */
async function workerLoop(workerId: number): Promise<void> {
  logger.info(`[worker-${workerId}] Apply Discovery Worker started`);

  while (!isShuttingDown && isDatabaseConnected()) {
    try {
      activeWorkers++;
      const result = await processNextDiscoveryJob();
      activeWorkers--;

      if (result.outcome === 'idle') {
        // No jobs in queue, wait before checking again
        await sleep(POLL_INTERVAL_MS);
      } else if (result.outcome === 'completed') {
        logger.info(
          `[worker-${workerId}] Job ${result.discoveryJobId ?? 'unknown'} completed successfully`,
        );
        // Process next job immediately
      } else if (result.outcome === 'not_found') {
        logger.warn(
          `[worker-${workerId}] Job ${result.discoveryJobId ?? 'unknown'} - no apply URL found`,
        );
        // Process next job immediately
      } else if (result.outcome === 'retry_scheduled') {
        logger.info(
          `[worker-${workerId}] Job ${result.discoveryJobId ?? 'unknown'} - retry scheduled`,
        );
        // Process next job immediately
      } else if (result.outcome === 'failed') {
        logger.error(
          `[worker-${workerId}] Job ${result.discoveryJobId ?? 'unknown'} failed: ${result.reason ?? 'unknown'}`,
        );
        // Process next job immediately
      }
    } catch (error: unknown) {
      activeWorkers--;
      logger.error(
        `[worker-${workerId}] Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      );
      // Wait before retrying on unexpected errors
      await sleep(POLL_INTERVAL_MS);
    }
  }

  logger.info(`[worker-${workerId}] Apply Discovery Worker stopped`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Graceful shutdown handler
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;

  logger.info(`[main] Received ${signal}, initiating graceful shutdown...`);
  isShuttingDown = true;

  // Wait for active workers to finish (max 30 seconds)
  const maxWaitMs = 30000;
  const startTime = Date.now();

  while (activeWorkers > 0 && Date.now() - startTime < maxWaitMs) {
    logger.info(`[main] Waiting for ${activeWorkers} active workers to finish...`);
    await sleep(1000);
  }

  if (activeWorkers > 0) {
    logger.warn(`[main] Shutdown timeout reached, ${activeWorkers} workers still active`);
  }

  logger.info('[main] Apply Discovery Worker shutdown complete');
  process.exit(0);
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  logger.info('[main] Starting Apply Discovery Worker...');
  logger.info(`[main] Configuration:
  - Poll Interval: ${POLL_INTERVAL_MS}ms
  - Concurrency: ${CONCURRENCY}
  - Firecrawl: ${env.APPLY_DISCOVERY_ENABLE_FIRECRAWL ? 'enabled' : 'disabled'}
  - Web Search: ${env.APPLY_DISCOVERY_ENABLE_WEB_SEARCH ? 'enabled' : 'disabled'}
  - Max External Calls: ${env.APPLY_DISCOVERY_MAX_EXTERNAL_CALLS}
  `);

  if (!env.APPLY_DISCOVERY_ENABLED) {
    logger.error('[main] APPLY_DISCOVERY_ENABLED is false - worker cannot start');
    process.exit(1);
  }

  // Connect to database
  await connectDatabase();

  if (!isDatabaseConnected()) {
    logger.error('[main] Failed to connect to database');
    process.exit(1);
  }

  // Setup graceful shutdown handlers
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start worker loops (parallel processing if concurrency > 1)
  const workers: Promise<void>[] = [];
  for (let i = 1; i <= CONCURRENCY; i++) {
    workers.push(workerLoop(i));
  }

  // Wait for all workers to complete
  await Promise.all(workers);
}

// Start the worker
main().catch((error: unknown) => {
  logger.error(
    `[main] Fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
