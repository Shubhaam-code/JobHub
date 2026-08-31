import type { RequestHandler } from 'express';
import morgan from 'morgan';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** HTTP access logging, routed through the app logger. Silent during tests. */
export function createRequestLogger(): RequestHandler {
  return morgan(env.isProduction ? 'combined' : 'dev', {
    skip: () => env.isTest,
    stream: {
      write: (line: string): void => logger.info(line.trimEnd()),
    },
  });
}
