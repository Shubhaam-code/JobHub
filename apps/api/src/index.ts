import http, { type Server as HttpServer } from 'node:http';

import { createApp } from './app.js';
import { connectDatabase, disconnectDatabase, redactUri } from './config/database.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeSocketServer, initSocketServer } from './lib/socket.js';
import { createTelegramClient } from './telegram/client.js';
import { startListener, type ListenerHandle } from './telegram/listener.js';

let telegramListener: ListenerHandle | null = null;

async function shutdown(server: HttpServer, signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down.`);

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

  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);

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
