import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { adminRouter } from './routes/admin.route.js';
import { authRouter } from './routes/auth.route.js';
import { healthRouter } from './routes/health.route.js';
import { apiRouter } from './routes/index.js';

/**
 * Builds the Express application. Kept separate from server startup so tests can
 * exercise the app without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigins }));
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(createRequestLogger());

  // Unversioned infrastructure probes.
  app.use('/health', healthRouter);

  // Authentication, and the admin-only surface behind it. Unversioned: these are
  // operator endpoints, not part of the public product API.
  app.use('/api/auth', authRouter);
  app.use('/api/admin', adminRouter);

  // Versioned application API.
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
