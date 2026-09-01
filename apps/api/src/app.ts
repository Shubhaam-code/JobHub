import compression from 'compression';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { errorHandler } from './middleware/error-handler.js';
import { notFoundHandler } from './middleware/not-found.js';
import { createRequestLogger } from './middleware/request-logger.js';
import { adminRouter } from './routes/admin.route.js';
import { authRouter } from './routes/auth.route.js';
import { healthRouter } from './routes/health.route.js';
import { apiRouter } from './routes/index.js';

/**
 * CORS, with a rejection that says so.
 *
 * The array form of this option is silent: a disallowed origin still gets its
 * 200 and its body, just without `Access-Control-Allow-Origin`, so the browser
 * discards a response the request log records as a success. That is exactly how
 * a wrong allow-list once emptied the whole site while every log line looked
 * healthy, so a rejection is now stated out loud.
 *
 * Each origin is logged once. A blocked origin is usually a misconfiguration,
 * which needs saying a single time; repeating it per request would just let a
 * scanner flood the log.
 */
function corsOptions(): Parameters<typeof cors>[0] {
  const reported = new Set<string>();

  return {
    origin(origin, callback) {
      /* No `Origin` header at all — a same-origin navigation, curl, a health
         probe, another service. There is no browser to protect, so this is not a
         cross-origin request and CORS has no opinion on it. */
      if (!origin || env.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      if (!reported.has(origin)) {
        reported.add(origin);
        logger.warn(
          `[cors] blocked ${origin} — it is not in the allow-list, so browsers there ` +
            'will see an empty response. Add it to CORS_ORIGINS if it is one of ours.',
        );
      }

      // `false`, not an error: the request is served as before, it just carries no
      // ACAO header. Throwing here would turn a config problem into a 500.
      callback(null, false);
    },
  };
}

/**
 * Builds the Express application. Kept separate from server startup so tests can
 * exercise the app without binding a port.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors(corsOptions()));
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
