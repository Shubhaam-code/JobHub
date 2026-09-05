import http, { type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import {
  broadcastNewJob,
  broadcastUpdatedJob,
  closeSocketServer,
  initSocketServer,
} from '../src/lib/socket.js';
import type { PublicJob } from '../src/routes/jobs.route.js';

describe('Socket.IO realtime updates', () => {
  let httpServer: HttpServer;
  let clientSocket: ClientSocket;
  let port: number;

  const mockPublicJob: PublicJob = {
    id: '64f1a2b3c4d5e6f7a8b9c999',
    company: 'TestCorp',
    role: 'Full Stack Engineer Intern',
    batch: '2027',
    applyUrl: 'https://example.com/apply-test',
    location: 'Bengaluru',
    employmentType: 'internship',
    companyLogoUrl: null,
    description: 'TestCorp hiring Full Stack Engineer Intern for 2027 batch',
    postedAt: '2026-08-31T10:00:00.000Z',
    createdAt: '2026-08-31T10:00:05.000Z',
    updatedAt: '2026-08-31T10:00:05.000Z',
    applyUrlVerified: true,
  };

  beforeAll(async () => {
    const app = createApp();
    httpServer = http.createServer(app);
    initSocketServer(httpServer);

    await new Promise<void>((resolve) => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (clientSocket && clientSocket.connected) {
      clientSocket.disconnect();
    }
    await closeSocketServer();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('1. connects to the Socket.IO server', async () => {
    clientSocket = ioc(`http://localhost:${port}`, {
      transports: ['websocket'],
    });

    await new Promise<void>((resolve) => {
      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        resolve();
      });
    });
  });

  it('2. receives job:new event when broadcastNewJob is called', async () => {
    const received = await new Promise<PublicJob>((resolve) => {
      clientSocket.on('job:new', (job: PublicJob) => {
        resolve(job);
      });

      broadcastNewJob(mockPublicJob);
    });

    expect(received).toEqual(mockPublicJob);
    expect(received.id).toBe('64f1a2b3c4d5e6f7a8b9c999');
    expect(received.company).toBe('TestCorp');
    expect(received.role).toBe('Full Stack Engineer Intern');
  });

  it('3. broadcasts no Telegram provenance — the socket is a public channel', async () => {
    const received = await new Promise<Record<string, unknown>>((resolve) => {
      clientSocket.once('job:new', (job: Record<string, unknown>) => resolve(job));

      broadcastNewJob(mockPublicJob);
    });

    for (const field of [
      'source',
      'telegramChannel',
      'telegramChannelId',
      'telegramMessageId',
      'telegramMessageUrl',
      'originalText',
    ]) {
      expect(received[field]).toBeUndefined();
    }
  });

  /* ── Feed separation ──────────────────────────────────────────────────────
     Global Internships have their own page, and the `/jobs` listeners prepend
     whatever arrives on `job:new` without looking at `source`. So the exclusion
     that the list query enforces with `$nin` has to hold here too, and the only
     way it can is by never emitting a Global Internship on the `/jobs` channel.
     These assert that both directions stay silent on the other's events — put a
     GitHub broadcast back on `job:new` and test 5 fails. */

  it('4. sends a global internship only on global-internship:new, never on job:new', async () => {
    const jobsFeed: PublicJob[] = [];
    const onJobNew = (job: PublicJob) => jobsFeed.push(job);
    clientSocket.on('job:new', onJobNew);

    const received = await new Promise<PublicJob>((resolve) => {
      clientSocket.once('global-internship:new', (job: PublicJob) => resolve(job));
      broadcastNewJob(mockPublicJob, 'global-internships');
    });

    clientSocket.off('job:new', onJobNew);

    expect(received.id).toBe(mockPublicJob.id);
    expect(jobsFeed).toHaveLength(0);
  });

  it('5. sends a normal job only on job:new, never on the global internships channel', async () => {
    const globalFeed: PublicJob[] = [];
    const onGlobalNew = (job: PublicJob) => globalFeed.push(job);
    clientSocket.on('global-internship:new', onGlobalNew);

    const received = await new Promise<PublicJob>((resolve) => {
      clientSocket.once('job:new', (job: PublicJob) => resolve(job));
      broadcastNewJob(mockPublicJob);
    });

    clientSocket.off('global-internship:new', onGlobalNew);

    expect(received.id).toBe(mockPublicJob.id);
    expect(globalFeed).toHaveLength(0);
  });

  it('6. separates the update events by feed as well', async () => {
    const jobsFeed: PublicJob[] = [];
    const onJobUpdated = (job: PublicJob) => jobsFeed.push(job);
    clientSocket.on('job:updated', onJobUpdated);

    const received = await new Promise<PublicJob>((resolve) => {
      clientSocket.once('global-internship:updated', (job: PublicJob) => resolve(job));
      broadcastUpdatedJob(mockPublicJob, 'global-internships');
    });

    clientSocket.off('job:updated', onJobUpdated);

    expect(received.id).toBe(mockPublicJob.id);
    expect(jobsFeed).toHaveLength(0);
  });
});
