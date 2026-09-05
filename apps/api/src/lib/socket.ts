import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from './logger.js';
import type { PublicJob } from '../routes/jobs.route.js';

let io: SocketIOServer | null = null;

/**
 * Which feed a realtime event belongs to.
 *
 * `jobs` is the normal feed — Telegram and every other ordinary source.
 * `global-internships` is the GitHub-backed feed, which has its own page.
 *
 * The two are separate events rather than one payload with a flag because the
 * clients are separate: the `/jobs` listeners prepend whatever arrives, so a
 * Global Internship broadcast on the shared channel put a card into `/jobs` that
 * its own query would never return. The source rule has to hold on this path too,
 * and a channel a client never subscribes to is a stronger guarantee than a filter
 * every listener has to remember to apply.
 */
export type JobFeed = 'jobs' | 'global-internships';

/** Event names per feed. `job:*` is unchanged, so existing clients keep working. */
const EVENT_NAMES: Record<JobFeed, { created: string; updated: string }> = {
  jobs: { created: 'job:new', updated: 'job:updated' },
  'global-internships': {
    created: 'global-internship:new',
    updated: 'global-internship:updated',
  },
};

/**
 * Initializes the Socket.IO server and binds it to the HTTP server.
 */
export function initSocketServer(httpServer: HttpServer): SocketIOServer {
  if (io) {
    return io;
  }

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: env.corsOrigins,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    logger.debug(`[socket.io] Client connected: ${socket.id}`);

    socket.on('disconnect', (reason) => {
      logger.debug(`[socket.io] Client disconnected: ${socket.id} (${reason})`);
    });
  });

  logger.info('[socket.io] Server initialized');
  return io;
}

/**
 * Returns the current Socket.IO server instance if initialized.
 */
export function getSocketServer(): SocketIOServer | null {
  return io;
}

/**
 * Announces a newly stored job to the clients of its own feed.
 *
 * `feed` defaults to `jobs`, so the Telegram/queue path needs no change. The
 * GitHub sync passes `global-internships` — see `JobFeed` for why that must not
 * ride on the `/jobs` channel.
 */
export function broadcastNewJob(job: PublicJob, feed: JobFeed = 'jobs'): void {
  const event = EVENT_NAMES[feed].created;

  if (!io) {
    logger.debug(`[socket.io] Cannot broadcast ${event} — socket server not initialized`);
    return;
  }

  io.emit(event, job);
  logger.info(`[socket.io] Broadcasted ${event} (id=${job.id}, role=${job.role ?? 'null'})`);
}

/**
 * Emits the update event for a job that already exists on the client.
 *
 * A separate event from the created one because the client's response differs:
 * created prepends a card, this one replaces a card in place. Emitting the created
 * event for an update would duplicate the row in every open feed.
 *
 * The whole public job is sent rather than a patch, so a client that missed an
 * earlier update still converges — and so the payload passes through the same
 * `formatJob` redaction as every other response.
 */
export function broadcastUpdatedJob(job: PublicJob, feed: JobFeed = 'jobs'): void {
  const event = EVENT_NAMES[feed].updated;

  if (!io) {
    logger.debug(`[socket.io] Cannot broadcast ${event} — socket server not initialized`);
    return;
  }

  io.emit(event, job);
  logger.info(
    `[socket.io] Broadcasted ${event} (id=${job.id}, applyUrlVerified=${String(job.applyUrlVerified)})`,
  );
}

/**
 * Closes the Socket.IO server gracefully during shutdown.
 */
export async function closeSocketServer(): Promise<void> {
  if (!io) return;

  await new Promise<void>((resolve) => {
    io?.close(() => {
      io = null;
      logger.info('[socket.io] Server closed.');
      resolve();
    });
  });
}
