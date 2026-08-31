import { env } from '../config/env.js';

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 } as const;

export type LogLevel = keyof typeof LEVEL_ORDER;

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] <= LEVEL_ORDER[env.LOG_LEVEL];
}

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) return;

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const write = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (meta === undefined) {
    write(line);
  } else {
    write(line, meta);
  }
}

/** Minimal leveled logger. Swap for pino/winston when the app needs transports. */
export const logger = {
  error: (message: string, meta?: unknown): void => emit('error', message, meta),
  warn: (message: string, meta?: unknown): void => emit('warn', message, meta),
  info: (message: string, meta?: unknown): void => emit('info', message, meta),
  debug: (message: string, meta?: unknown): void => emit('debug', message, meta),
};
