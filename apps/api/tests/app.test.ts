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

describe('GET /health/ready', () => {
  // createApp() never calls connectDatabase(), so readiness is deterministically
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
