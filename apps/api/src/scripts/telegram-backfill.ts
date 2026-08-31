/**
 * Standalone 7-day backfill for every configured channel.
 *
 *   npm run telegram:backfill --workspace @jia/api
 *
 * Resolves TELEGRAM_CHANNELS, walks the last 7 days of each channel's history,
 * and runs every post through the normal pipeline (normalize → sanitize → dedupe
 * → durable queue). No listener, no HTTP server.
 *
 * It fills the queue; it does not classify. The LLM worker drains the queue, so a
 * backfill finishes at Telegram's pace rather than the provider's, and a rate
 * limit cannot make it lose messages.
 *
 * Safe to run repeatedly: deduplication is the queue's unique message key, so a
 * second run only reports duplicates.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isLlmConfigured, llmModelName } from '../llm/client.js';
import { JobModel } from '../models/job.model.js';
import { getQueueCounts } from '../queue/ingest-queue.js';
import { runBackfill, BACKFILL_WINDOW_DAYS, type BackfillSummary } from '../telegram/backfill.js';
import { ensureConfiguredChannels } from '../telegram/channel-registry.js';
import { resolveConfiguredChannels } from '../telegram/channels.js';
import {
  createTelegramClient,
  readTelegramCredentials,
  TelegramConfigError,
} from '../telegram/client.js';

interface ChannelRun {
  username: string;
  summary: BackfillSummary;
}

/** Per-channel stored job counts, straight from MongoDB. */
async function reportStoredCounts(): Promise<void> {
  const rows = await JobModel.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$telegramChannel', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  const total = await JobModel.countDocuments();

  console.log('');
  console.log(`MongoDB jobs per channel (total ${total}):`);
  for (const row of rows) {
    console.log(`  @${row._id}: ${row.count}`);
  }
}

async function main(): Promise<void> {
  readTelegramCredentials();

  if (!env.TELEGRAM_SESSION) {
    throw new TelegramConfigError(
      'TELEGRAM_SESSION is not set. Run `npm run telegram:login --workspace @jia/api` first, ' +
        'then put the printed session string in apps/api/.env.',
    );
  }

  // Not fatal any more: a backfill only fills the queue, so it is worth running
  // without a key. The worker classifies whatever is waiting once one is set.
  if (!isLlmConfigured()) {
    logger.warn(
      '[backfill] GEMINI_API_KEY is not set — messages will be queued but nothing will be ' +
        'classified until it is. Set it in apps/api/.env and the worker picks them up.',
    );
  } else {
    logger.info(`[backfill] Classifier model: ${llmModelName()}`);
  }

  logger.info(`[backfill] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — a backfill needs a working database.');
  }

  // Keeps the registry in step with TELEGRAM_CHANNELS without re-enabling a
  // channel an admin paused.
  await ensureConfiguredChannels();

  const handle = createTelegramClient();
  handle.client.floodSleepThreshold = 0;

  const runs: ChannelRun[] = [];

  try {
    await handle.client.connect();

    if (!(await handle.client.isUserAuthorized())) {
      throw new Error('Telegram session is not authorized. Run `npm run telegram:login` again.');
    }

    const { resolved, failed } = await resolveConfiguredChannels(handle.client);

    if (resolved.length === 0) {
      throw new Error('None of the configured channels could be resolved.');
    }

    for (const channel of resolved) {
      logger.info(`[backfill] @${channel.username}: starting...`);

      try {
        const summary = await runBackfill({
          client: handle.client,
          entity: channel.entity,
          channelUsername: channel.username,
          channelId: channel.id.toString(),
        });
        runs.push({ username: channel.username, summary });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[backfill] @${channel.username}: failed — ${message}`);
      }
    }

    // ── Report ──────────────────────────────────────────────────────────────
    const totals = runs.reduce(
      (acc, run) => ({
        fetched: acc.fetched + run.summary.fetched,
        eligible: acc.eligible + run.summary.eligible,
        queued: acc.queued + run.summary.queued,
        duplicates: acc.duplicates + run.summary.duplicates,
        skipped: acc.skipped + run.summary.skipped,
        errors: acc.errors + run.summary.errors,
      }),
      { fetched: 0, eligible: 0, queued: 0, duplicates: 0, skipped: 0, errors: 0 },
    );

    console.log('');
    console.log(`${BACKFILL_WINDOW_DAYS}-day backfill per channel:`);
    for (const { username, summary } of runs) {
      console.log(
        `  @${username}: fetched=${summary.fetched} eligible=${summary.eligible} ` +
          `queued=${summary.queued} duplicates=${summary.duplicates} ` +
          `skipped=${summary.skipped} errors=${summary.errors}` +
          (summary.floodWaitSeconds ? ` floodWait=${summary.floodWaitSeconds}s` : '') +
          (summary.truncated ? ' TRUNCATED' : ''),
      );
    }

    console.log('');
    console.log(
      `TOTAL: channels=${runs.length}/${env.telegramChannels.length} ` +
        `fetched=${totals.fetched} eligible=${totals.eligible} queued=${totals.queued} ` +
        `duplicates=${totals.duplicates} skipped=${totals.skipped} errors=${totals.errors}`,
    );

    // Backfill only fills the queue; the worker classifies and stores.
    const queue = await getQueueCounts();
    console.log('');
    console.log(
      `Ingest queue: pending=${queue.pending} processing=${queue.processing} ` +
        `retry_wait=${queue.retry_wait} completed=${queue.completed} failed=${queue.failed}`,
    );
    console.log(
      'Queued messages are classified by the LLM worker (started with the API server).\n' +
        'Check progress any time with `npm run queue:status --workspace @jia/api`.',
    );

    if (failed.length > 0) {
      console.log(`Unresolved channels: ${failed.map((name) => `@${name}`).join(', ')}`);
    }

    await reportStoredCounts();
  } finally {
    await handle.client.disconnect().catch(() => {});
    await handle.client.destroy().catch(() => {});
    await disconnectDatabase();
  }
}

try {
  await main();
  // GramJS keeps timers and sockets alive; exit explicitly so the script ends.
  process.exit(0);
} catch (error) {
  if (error instanceof TelegramConfigError) {
    logger.error(error.message);
  } else {
    logger.error(`[backfill] Fatal error: ${error instanceof Error ? error.message : error}`);
  }
  process.exit(1);
}
