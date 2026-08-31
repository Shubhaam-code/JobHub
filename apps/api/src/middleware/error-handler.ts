import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env.js';
import { HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';

interface ErrorResponseBody {
  error: {
    message: string;
    statusCode: number;
    details?: unknown;
    stack?: string;
  };
}

/**
 * Resolves the status code to send for a thrown value.
 *
 * Express middleware (body-parser, multer, …) signal their own status via the
 * `http-errors` convention of a numeric `status`/`statusCode` property, so honour
 * that instead of flattening every non-HttpError into a 500.
 */
function resolveStatusCode(err: unknown): number {
  if (err instanceof HttpError) return err.statusCode;

  if (typeof err === 'object' && err !== null) {
    const candidate = err as { statusCode?: unknown; status?: unknown };

    for (const value of [candidate.statusCode, candidate.status]) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599) {
        return value;
      }
    }
  }

  return 500;
}

/**
 * Centralized error handler. Must keep all four parameters — Express identifies
 * error middleware by function arity.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const statusCode = resolveStatusCode(err);
  const message = err instanceof Error ? err.message : 'Unknown error';

  if (statusCode >= 500) {
    logger.error(`Unhandled error: ${message}`, err);
  } else {
    logger.warn(`Request failed (${statusCode}): ${message}`);
  }

  const body: ErrorResponseBody = {
    error: {
      // Never leak internal failure details in production.
      message: statusCode >= 500 && env.isProduction ? 'Internal Server Error' : message,
      statusCode,
    },
  };

  if (err instanceof HttpError && err.details !== undefined) {
    body.error.details = err.details;
  }

  if (!env.isProduction && err instanceof Error && err.stack) {
    body.error.stack = err.stack;
  }

  res.status(statusCode).json(body);
}
