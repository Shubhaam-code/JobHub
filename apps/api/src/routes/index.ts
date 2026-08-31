import { Router } from 'express';

import { jobsRouter } from './jobs.route.js';

export const API_VERSION = 'v1';

export const apiRouter = Router();

apiRouter.use('/jobs', jobsRouter);

/** Service index — lists what this version of the API currently exposes. */
apiRouter.get('/', (_req, res) => {
  res.status(200).json({
    name: 'job-internship-aggregator-api',
    version: API_VERSION,
    phase: 0,
    endpoints: [
      'GET /health',
      'GET /health/ready',
      `GET /api/${API_VERSION}`,
      `GET /api/${API_VERSION}/jobs`,
      `GET /api/${API_VERSION}/jobs/channels`,
      `GET /api/${API_VERSION}/jobs/:id`,
    ],
  });
});
