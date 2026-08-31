/**
 * Standalone 7-day backfill for every configured channel.
 *
 *   npm run telegram:backfill --workspace @jia/api
 *
 * Resolves TELEGRAM_CHANNELS, walks the last 7 days of each channel's history,
 * and runs every post through the normal pipeline (pre-filter → LLM classify →
 * validate → dedupe → MongoDB). No listener, no HTTP server.
 *
 * Safe to run repeatedly: deduplication is the unique
 * (telegramChannel, telegramMessageId) index, so a second run only reports
 * duplicates.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isLlmConfigured, llmModelName } from '../llm/client.js';
import { JobModel } from '../models/job.model.js';
import { runBackfill, BACKFILL_WINDOW_DAYS, type BackfillSummary } from '../telegram/backfill.js';
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

  if (!isLlmConfigured()) {
    throw new Error(
      'GEMINI_API_KEY is not set. Classification is what decides whether a post is a job, so a ' +
        'backfill without it would store nothing. Set it in apps/api/.env and re-run.',
    );
  }

  logger.info(`[backfill] Classifier model: ${llmModelName()}`);
  logger.info(`[backfill] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — a backfill needs a working database.');
  }

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
        inserted: acc.inserted + run.summary.inserted,
        duplicates: acc.duplicates + run.summary.duplicates,
        skipped: acc.skipped + run.summary.skipped,
        errors: acc.errors + run.summary.errors,
      }),
      { fetched: 0, eligible: 0, inserted: 0, duplicates: 0, skipped: 0, errors: 0 },
    );

    console.log('');
    console.log(`${BACKFILL_WINDOW_DAYS}-day backfill per channel:`);
    for (const { username, summary } of runs) {
      console.log(
        `  @${username}: fetched=${summary.fetched} eligible=${summary.eligible} ` +
          `inserted=${summary.inserted} duplicates=${summary.duplicates} ` +
          `skipped=${summary.skipped} errors=${summary.errors}` +
          (summary.floodWaitSeconds ? ` floodWait=${summary.floodWaitSeconds}s` : '') +
          (summary.truncated ? ' TRUNCATED' : ''),
      );
    }

    console.log('');
    console.log(
      `TOTAL: channels=${runs.length}/${env.telegramChannels.length} ` +
        `fetched=${totals.fetched} eligible=${totals.eligible} inserted=${totals.inserted} ` +
        `duplicates=${totals.duplicates} skipped=${totals.skipped} errors=${totals.errors}`,
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
