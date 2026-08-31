import mongoose from 'mongoose';

import { logger } from '../lib/logger.js';
import { env } from './env.js';

export type DatabaseStatus =
  'uninitialized' | 'disconnected' | 'connecting' | 'connected' | 'disconnecting' | 'unknown';

const READY_STATE_LABELS: Record<number, DatabaseStatus> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
  99: 'uninitialized',
};

/** Hides credentials so a connection string is safe to log. */
export function redactUri(uri: string): string {
  return uri.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');
}

export function getDatabaseStatus(): DatabaseStatus {
  return READY_STATE_LABELS[mongoose.connection.readyState] ?? 'unknown';
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

let listenersRegistered = false;

function registerConnectionListeners(): void {
  if (listenersRegistered) return;
  listenersRegistered = true;

  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (error: unknown) =>
    logger.error('MongoDB connection error', error instanceof Error ? error.message : error),
  );
}

/**
 * Connects to MongoDB. Deliberately non-fatal: the API still boots and serves
 * `/health` when the database is unreachable, so local development does not
 * require a running mongod. `/health/ready` reports the real state.
 */
export async function connectDatabase(): Promise<boolean> {
  registerConnectionListeners();

  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 5_000 });
    return true;
  } catch (error) {
    logger.error(
      `Could not connect to MongoDB at ${redactUri(env.MONGODB_URI)} — starting without a database connection.`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

export async function disconnectDatabase(): Promise<void> {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
}
