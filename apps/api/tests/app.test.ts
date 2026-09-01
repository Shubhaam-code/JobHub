import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';

const app = createApp();

describe('GET /health', () => {
  it('reports the service as live', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.environment).toBe('test');
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(typeof response.body.timestamp).toBe('string');
    expect(response.body.database).toHaveProperty('status');
    expect(response.body.database).toHaveProperty('connected');
  });

  it('omits the x-powered-by header and sets helmet defaults', async () => {
    const response = await request(app).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

/**
 * A missing `Access-Control-Allow-Origin` is the quietest possible outage: the
 * API answers 200 with the right body, the browser throws it away, and the
 * request log shows a success. That happened in production and emptied the whole
 * site, so the header is asserted directly here.
 */
describe('CORS', () => {
  const DEPLOYED_FRONTEND = 'https://job-hub-web-ochre.vercel.app';

  it('allows the deployed frontend to read a response', async () => {
    const response = await request(app).get('/health').set('Origin', DEPLOYED_FRONTEND);

    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(DEPLOYED_FRONTEND);
  });

  it('answers the browser preflight for a real API call', async () => {
    const response = await request(app)
      .options('/api/v1/jobs')
      .set('Origin', DEPLOYED_FRONTEND)
      .set('Access-Control-Request-Method', 'GET');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(DEPLOYED_FRONTEND);
  });

  it('allows localhost, so development is not blocked either', async () => {
    const response = await request(app).get('/health').set('Origin', 'http://localhost:3000');

    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('withholds the header from an origin that is not ours', async () => {
    const response = await request(app).get('/health').set('Origin', 'https://evil.test');

    // Still served — the header, not the response, is what CORS withholds.
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves callers that send no Origin at all, like curl and health probes', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
  });
});

describe('GET /health/ready', () => {  // createApp() never calls connectDatabase(), so readiness is deterministically
  // "not-ready" here whether or not a mongod happens to be running locally.
  it('reports not-ready until a database connection is established', async () => {
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'not-ready',
      database: { connected: false },
    });
  });
});

describe('GET /api/v1', () => {
  it('describes the service', async () => {
    const response = await request(app).get('/api/v1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      name: 'job-internship-aggregator-api',
      version: 'v1',
      phase: 0,
    });
    expect(Array.isArray(response.body.endpoints)).toBe(true);
  });
});

describe('error handling', () => {
  it('returns a 404 envelope for unknown routes', async () => {
    const response = await request(app).get('/nope');

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ statusCode: 404 });
    expect(response.body.error.message).toContain('/nope');
  });

  it('rejects malformed JSON bodies with a 400', async () => {
    const response = await request(app)
      .post('/api/v1')
      .set('Content-Type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.error.statusCode).toBe(400);
  });
});
