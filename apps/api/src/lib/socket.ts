import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';

import { env } from '../config/env.js';
import { logger } from './logger.js';
import type { PublicJob } from '../routes/jobs.route.js';

let io: SocketIOServer | null = null;

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
 * Emits "job:new" event to all connected clients with safe public job data.
 */
export function broadcastNewJob(job: PublicJob): void {
  if (!io) {
    logger.debug('[socket.io] Cannot broadcast job:new — socket server not initialized');
    return;
  }

  io.emit('job:new', job);
  logger.info(`[socket.io] Broadcasted job:new (id=${job.id}, role=${job.role ?? 'null'})`);
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
