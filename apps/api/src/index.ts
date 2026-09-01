import http, { type Server as HttpServer } from 'node:http';

import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase, redactUri } from './config/database.js';
import { env } from './config/env.js';
import { seedAdminUser } from './lib/auth.js';
import { logger } from './lib/logger.js';
import { closeSocketServer, initSocketServer } from './lib/socket.js';
import { recoverStaleClaims } from './queue/ingest-queue.js';
import { startQueueWorker, type QueueWorker } from './queue/worker.js';
import { warmPdfParser } from './resume/pdf-text.js';
import { ensureConfiguredChannels } from './telegram/channel-registry.js';
import { createTelegramClient } from './telegram/client.js';
import { startListener, type ListenerHandle } from './telegram/listener.js';

let telegramListener: ListenerHandle | null = null;
let queueWorker: QueueWorker | null = null;

async function shutdown(server: HttpServer, signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down.`);

  // Stopped before the database closes so the in-flight message can finish its
  // write. Anything still `processing` is reclaimed by recoverStaleClaims() on
  // the next boot, so a hard kill here costs a retry, never a message.
  if (queueWorker) {
    try {
      await queueWorker.stop();
    } catch (err) {
      logger.warn('Error stopping the queue worker', err);
    }
  }

  if (telegramListener) {
    try {
      await telegramListener.stop();
      logger.info('Telegram listener stopped.');
    } catch (err) {
      logger.warn('Error stopping Telegram listener', err);
    }
  }

  await closeSocketServer();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await disconnectDatabase();
  logger.info('Shutdown complete.');
}

async function main(): Promise<void> {
  logger.info(`Starting API (env=${env.NODE_ENV}, log level=${env.LOG_LEVEL}).`);
  logger.info(`MongoDB target: ${redactUri(env.MONGODB_URI)}`);
  /* Logged because its absence is invisible from the outside: a browser origin
     that is not on this list gets a 200 with no `Access-Control-Allow-Origin`,
     the browser throws the response away, and the API logs a perfectly ordinary
     successful request. Printing the list turns "the site shows no data" into a
     one-line check. */
  logger.info(`CORS allow-list: ${env.corsOrigins.join(', ')}`);

  await connectDatabase();

  // Both of these are non-fatal, like the Telegram startup further down: the API
  // must still serve jobs if either fails.
  try {
    const seeded = await seedAdminUser();
    if (seeded === 'created') logger.info('[startup] Admin user created from ADMIN_EMAIL.');
    if (seeded === 'promoted') logger.info('[startup] ADMIN_EMAIL user promoted to ADMIN.');
  } catch (error: unknown) {
    logger.warn('[startup] Could not seed the admin user', error);
  }

  // Also done by the listener, but the listener only runs when Telegram is
  // configured — the admin dashboard needs its rows either way.
  try {
    const registered = await ensureConfiguredChannels();
    logger.info(`[startup] Channel registry reconciled (${registered} configured channels).`);
  } catch (error: unknown) {
    logger.warn('[startup] Could not reconcile the channel registry', error);
  }

  const app = createApp();
  const server = http.createServer(app);

  /* Deliberately not awaited: pdfjs takes seconds to evaluate and nothing about
     serving jobs depends on it, so it loads alongside the rest of startup. It
     logs its own failure and never rejects. */
  void warmPdfParser();

  // Initialize Socket.IO attached to the HTTP server
  initSocketServer(server);

  server.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}`);
    logger.info(`Health:  http://localhost:${env.PORT}/health`);
    logger.info(`API root: http://localhost:${env.PORT}/api/v1`);
  });

  // Registered before the Telegram startup below: resolving channels and running
  // the 7-day backfill can take a while, and Ctrl+C during it must still shut the
  // HTTP server, Socket.IO and MongoDB down cleanly.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      shutdown(server, signal).then(
        () => process.exit(0),
        (error: unknown) => {
          logger.error('Error during shutdown', error);
          process.exit(1);
        },
      );
    });
  }

  // ── LLM worker ────────────────────────────────────────────────────────────
  //
  // Started before Telegram on purpose. Resolving channels and walking a 7-day
  // backfill can take minutes, and the queue should be draining throughout —
  // ingestion and classification are independent halves of the pipeline.
  if (env.QUEUE_WORKER_ENABLED) {
    try {
      // Any message left `processing` by a crash or a kill -9 is released back
      // to `pending` here. This is what makes the queue restart-safe.
      const recovered = await recoverStaleClaims();
      if (recovered > 0) {
        logger.warn(`[startup] Recovered ${recovered} stale queue claim(s) from a previous run.`);
      }
    } catch (error: unknown) {
      logger.warn('[startup] Could not recover stale queue claims', error);
    }

    queueWorker = startQueueWorker();
  } else {
    logger.warn(
      '[startup] QUEUE_WORKER_ENABLED=false — messages will queue up but nothing will classify ' +
        'them in this process.',
    );
  }

  // Start Telegram listener if credentials are configured
  if (env.TELEGRAM_SESSION && env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH) {
    try {
      logger.info('[startup] Initializing Telegram client for realtime listener...');
      const handle = createTelegramClient();
      handle.client.floodSleepThreshold = 0;
      await handle.client.connect();

      if (await handle.client.isUserAuthorized()) {
        telegramListener = await startListener(handle);
        logger.info('[startup] Realtime Telegram listener attached.');
      } else {
        logger.warn(
          '[startup] Telegram session not authorized. Run `npm run telegram:login` to authorize.',
        );
      }
    } catch (error) {
      logger.warn('[startup] Could not start Telegram listener automatically:', error);
    }
  }
}

main().catch((error: unknown) => {
  logger.error('Fatal error during startup', error);
  process.exit(1);
});
