/**
 * Reports the state of the durable ingest queue.
 *
 *   npm run queue:status --workspace @jia/api
 *   npm run queue:status --workspace @jia/api -- --failed
 *
 * Flags:
 *   --failed   also list the dead-lettered messages with their last error
 *
 * Read-only: it never claims, retries or deletes anything, so it is safe to run
 * against a live system while the worker is draining the queue.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { IngestQueueModel } from '../models/ingest-queue.model.js';
import { countClaimable, getQueueCounts } from '../queue/ingest-queue.js';

const SHOW_FAILED = process.argv.includes('--failed');

interface QueueRow {
  telegramChannel: string;
  telegramMessageId: number;
  attempts: number;
  lastError?: string | null;
  nextRetryAt?: Date | null;
  receivedAt?: Date | null;
}

const clock = (value: Date | null | undefined): string =>
  value instanceof Date ? value.toISOString().replace('T', ' ').slice(0, 19) : '—';

/** "in 42s" / "overdue by 8s" — the retry schedule at a glance. */
function relative(target: Date | null | undefined, now: number): string {
  if (!(target instanceof Date)) return 'now';

  const deltaSeconds = Math.round((target.getTime() - now) / 1000);

  return deltaSeconds > 0 ? `in ${deltaSeconds}s` : `overdue by ${Math.abs(deltaSeconds)}s`;
}

async function main(): Promise<void> {
  logger.info(`[queue-status] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — the queue lives in the database.');
  }

  const now = Date.now();
  const [counts, claimable] = await Promise.all([getQueueCounts(), countClaimable(new Date(now))]);

  console.log('');
  console.log('Ingest queue:');
  console.log(`  pending:    ${counts.pending}`);
  console.log(`  processing: ${counts.processing}`);
  console.log(`  retry_wait: ${counts.retry_wait}`);
  console.log(`  completed:  ${counts.completed}`);
  console.log(`  failed:     ${counts.failed}`);
  console.log(`  total:      ${counts.total}`);
  console.log('');
  console.log(`Claimable right now: ${claimable} (pending + retries that are due)`);
  console.log(
    `Worker settings: enabled=${env.QUEUE_WORKER_ENABLED} poll=${env.QUEUE_POLL_INTERVAL_MS}ms ` +
      `maxAttempts=${env.QUEUE_MAX_ATTEMPTS} rpm=${env.LLM_MAX_REQUESTS_PER_MINUTE} ` +
      `concurrency=${env.LLM_CONCURRENCY}`,
  );

  // Waiting retries, soonest first: this is where a rate limit shows up.
  if (counts.retry_wait > 0) {
    const waiting = await IngestQueueModel.find({ status: 'retry_wait' })
      .sort({ nextRetryAt: 1 })
      .limit(10)
      .lean<QueueRow[]>();

    console.log('');
    console.log(`Waiting to retry (showing ${waiting.length} of ${counts.retry_wait}):`);
    for (const row of waiting) {
      console.log(
        `  @${row.telegramChannel} msg ${row.telegramMessageId} ` +
          `attempt=${row.attempts}/${env.QUEUE_MAX_ATTEMPTS} ` +
          `retry ${relative(row.nextRetryAt, now)} (${clock(row.nextRetryAt)})`,
      );
      if (row.lastError) console.log(`      last error: ${row.lastError}`);
    }
  }

  if (counts.failed > 0) {
    console.log('');
    if (SHOW_FAILED) {
      const failed = await IngestQueueModel.find({ status: 'failed' })
        .sort({ receivedAt: -1 })
        .limit(25)
        .lean<QueueRow[]>();

      console.log(`Dead-lettered (showing ${failed.length} of ${counts.failed}):`);
      for (const row of failed) {
        console.log(
          `  @${row.telegramChannel} msg ${row.telegramMessageId} ` +
            `attempts=${row.attempts} received=${clock(row.receivedAt)}`,
        );
        if (row.lastError) console.log(`      last error: ${row.lastError}`);
      }
      // Dead-lettered rows keep their raw text, so nothing is lost by parking them.
      console.log('');
      console.log('Failed messages keep their raw text; none of this is discarded.');
    } else {
      console.log(`${counts.failed} message(s) are dead-lettered. Re-run with --failed to list.`);
    }
  }

  await disconnectDatabase();
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[queue-status] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
