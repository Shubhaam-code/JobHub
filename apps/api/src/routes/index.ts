import { Router } from 'express';

import { jobsRouter } from './jobs.route.js';
import { globalInternshipsRouter } from './global-internships.route.js';
import { profileRouter } from './profile.route.js';

export const API_VERSION = 'v1';

export const apiRouter = Router();

apiRouter.use('/jobs', jobsRouter);
apiRouter.use('/global-internships', globalInternshipsRouter);
apiRouter.use('/profile', profileRouter);

/**
 * Service index — lists what this version of the API currently exposes.
 * `/api/admin/*` is deliberately omitted: the index is public, and the admin
 * surface is not advertised to anonymous callers.
 */
apiRouter.get('/', (_req, res) => {
  res.status(200).json({
    name: 'job-internship-aggregator-api',
    version: API_VERSION,
    phase: 0,
    endpoints: [
      'GET /health',
      'GET /health/ready',
      `GET /api/${API_VERSION}/global-internships`,
      `GET /api/${API_VERSION}/global-internships/:id`,
      'POST /api/auth/login',
      'GET /api/auth/me',
      `GET /api/${API_VERSION}`,
      `GET /api/${API_VERSION}/jobs`,
      `GET /api/${API_VERSION}/jobs/recommended`,
      `GET /api/${API_VERSION}/jobs/:id`,
      `POST /api/${API_VERSION}/profile/resume`,
      `GET /api/${API_VERSION}/profile`,
      `PUT /api/${API_VERSION}/profile`,
    ],
  });
});
