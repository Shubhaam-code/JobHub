/**
 * Dev runner for the Telegram ingestion listener.
 *
 *   npm run telegram:listen --workspace @jia/api
 *
 * Connects to MongoDB (hard fail if unavailable), starts the GramJS listener
 * for every channel in TELEGRAM_CHANNELS, and runs until SIGINT/SIGTERM.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  createTelegramClient,
  readTelegramCredentials,
  TelegramConfigError,
} from '../telegram/client.js';
import { startListener, type ListenerHandle } from '../telegram/listener.js';

async function main(): Promise<void> {
  // ── Validate Telegram credentials ────────────────────────────────────────
  readTelegramCredentials();

  if (!env.TELEGRAM_SESSION) {
    throw new TelegramConfigError(
      'TELEGRAM_SESSION is not set. Run `npm run telegram:login --workspace @jia/api` first, ' +
        'then put the printed session string in apps/api/.env.',
    );
  }

  // ── Connect MongoDB (hard fail) ──────────────────────────────────────────
  logger.info(`[startup] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);
  const dbOk = await connectDatabase();

  if (!dbOk) {
    throw new Error(
      'MongoDB connection failed. The listener requires a working database — exiting.',
    );
  }

  logger.info('[startup] MongoDB connected.');

  // ── Connect Telegram ─────────────────────────────────────────────────────
  const handle = createTelegramClient();
  handle.client.floodSleepThreshold = 0;

  logger.info('[startup] Connecting to Telegram...');
  await handle.client.connect();

  if (!(await handle.client.isUserAuthorized())) {
    throw new Error('Telegram session is not authorized. Run `npm run telegram:login` again.');
  }

  logger.info('[startup] Telegram connected and authorized.');

  // ── Start the listener ───────────────────────────────────────────────────
  let listener: ListenerHandle | null = null;

  try {
    listener = await startListener(handle);
  } catch (error) {
    // If startListener fails (e.g. channel resolution), clean up.
    await handle.client.disconnect().catch(() => {});
    await disconnectDatabase();
    throw error;
  }

  // ── Graceful shutdown ────────────────────────────────────────────────────
  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info(`[shutdown] Received ${signal} — shutting down...`);

    if (listener) {
      await listener.stop();
    }

    await disconnectDatabase();
    logger.info('[shutdown] Shutdown complete.');
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(signal).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('[shutdown] Error during shutdown', error);
          process.exit(1);
        },
      );
    });
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof TelegramConfigError) {
    logger.error(error.message);
  } else {
    logger.error('[startup] Fatal error', error instanceof Error ? error.message : error);
  }

  process.exit(1);
}
