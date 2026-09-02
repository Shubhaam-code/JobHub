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
let shuttingDown = false;

/** Hard ceiling on the whole teardown; past it the process is killed outright. */
const SHUTDOWN_TIMEOUT_MS = 10_000;
/** Per-step ceiling, so one slow subsystem cannot eat the whole budget. */
const STEP_TIMEOUT_MS = 5_000;

/**
 * Runs `task`, but gives up after `ms` instead of blocking teardown forever.
 *
 * `queueWorker.stop()` waits for the in-flight message, and that message may be
 * inside an LLM call or a rate-limit sleep — up to a minute. Waiting for it
 * while the HTTP server still holds the port is what produced the EADDRINUSE
 * crash loop under `tsx watch`.
 */
async function withTimeout(label: string, ms: number, task: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });

  try {
    const result = await Promise.race([task.then(() => 'done' as const), expired]);
    if (result === 'timeout') logger.warn(`${label} did not finish in ${ms}ms — leaving it.`);
  } catch (err) {
    logger.warn(`Error during ${label}`, err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function shutdown(server: HttpServer, signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down.`);

  /* The port goes first, before anything that can block. `tsx watch` (and Render)
     start the replacement process as soon as the signal is sent, so every extra
     millisecond spent holding :PORT is a millisecond the new process can lose to
     EADDRINUSE.

     server.close() stops the listener immediately — the callback is what waits,
     for every keep-alive and WebSocket socket to go idle on its own. So the
     connections are destroyed right after, before anything is awaited: that is
     what turns "eventually" into "now" for both this callback and io.close(),
     which closes the same HTTP server underneath. */
  const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await withTimeout('Socket.IO close', STEP_TIMEOUT_MS, closeSocketServer());
  await withTimeout('HTTP server close', STEP_TIMEOUT_MS, httpClosed);
  logger.info(`Port ${env.PORT} released.`);

  // Stopped before the database closes so the in-flight message can finish its
  // write. Anything still `processing` is reclaimed by recoverStaleClaims() on
  // the next boot, so a hard kill here costs a retry, never a message.
  if (queueWorker) {
    await withTimeout('queue worker stop', STEP_TIMEOUT_MS, queueWorker.stop());
  }

  if (telegramListener) {
    await withTimeout('Telegram listener stop', STEP_TIMEOUT_MS, telegramListener.stop());
  }

  await withTimeout('MongoDB disconnect', STEP_TIMEOUT_MS, disconnectDatabase());
  logger.info('Shutdown complete.');
}

/**
 * Binds the server, retrying a busy port for a short while.
 *
 * The predecessor process can still be draining its own teardown when the
 * replacement boots — a restart is a handover, not a fresh start. Retrying beats
 * dying: an unhandled `error` event here killed the process with a stack trace,
 * and under a watcher that turned one slow shutdown into a dev server that
 * stayed down until it was restarted by hand.
 */
async function listen(server: HttpServer, attempts = 10, delayMs = 400): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        /* Both handlers are `once` and both are removed on settle. A failed
           attempt used to leave its success callback behind — `listen(port, cb)`
           registers cb as a 'listening' listener, and nothing unregisters it when
           the bind fails — so ten retries meant ten dead listeners and a
           MaxListenersExceededWarning on top of the real problem. */
        const onListening = (): void => {
          server.removeListener('error', onError);
          resolve();
        };
        const onError = (error: NodeJS.ErrnoException): void => {
          server.removeListener('listening', onListening);
          reject(error);
        };

        server.once('listening', onListening);
        server.once('error', onError);
        server.listen(env.PORT);
      });
      return;
    } catch (error: unknown) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!busy || attempt >= attempts) {
        if (busy) {
          logger.error(
            `Port ${env.PORT} is still in use after ${attempts} attempts. Something else is ` +
              'holding it — stop that process, or set PORT to a free port.',
          );
        }
        throw error;
      }

      logger.warn(
        `Port ${env.PORT} is busy (attempt ${attempt}/${attempts}) — retrying in ${delayMs}ms.`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
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

  await listen(server);
  logger.info(`API listening on http://localhost:${env.PORT}`);
  logger.info(`Health:  http://localhost:${env.PORT}/health`);
  logger.info(`API root: http://localhost:${env.PORT}/api/v1`);

  // Registered before the Telegram startup below: resolving channels and running
  // the 7-day backfill can take a while, and Ctrl+C during it must still shut the
  // HTTP server, Socket.IO and MongoDB down cleanly.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      /* A watcher that thinks the process is stuck sends the signal again, and an
         impatient Ctrl+C does the same. Re-entering shutdown() would close an
         already-closed server; the second signal means "stop waiting" instead. */
      if (shuttingDown) {
        logger.warn(`Received ${signal} again — exiting now.`);
        process.exit(0);
      }
      shuttingDown = true;

      /* Backstop for anything that ignores its own timeout — an open Telegram
         socket, a Mongoose operation mid-flight. Unref'd, so it never delays an
         exit that happens on its own. */
      const kill = setTimeout(() => {
        logger.warn(`Shutdown exceeded ${SHUTDOWN_TIMEOUT_MS}ms — exiting anyway.`);
        process.exit(0);
      }, SHUTDOWN_TIMEOUT_MS);
      kill.unref?.();

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
