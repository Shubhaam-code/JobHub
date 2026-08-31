import { Router } from 'express';

import { getDatabaseStatus, isDatabaseConnected } from '../config/database.js';
import { env } from '../config/env.js';

export const healthRouter = Router();

/** Liveness: the process is up and serving. Always 200 if it can respond. */
healthRouter.get('/', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    environment: env.NODE_ENV,
    uptimeSeconds: Number(process.uptime().toFixed(3)),
    timestamp: new Date().toISOString(),
    database: {
      status: getDatabaseStatus(),
      connected: isDatabaseConnected(),
    },
  });
});

/** Readiness: 503 until dependencies (MongoDB) are actually usable. */
healthRouter.get('/ready', (_req, res) => {
  const connected = isDatabaseConnected();

  res.status(connected ? 200 : 503).json({
    status: connected ? 'ready' : 'not-ready',
    database: {
      status: getDatabaseStatus(),
      connected,
    },
  });
});
