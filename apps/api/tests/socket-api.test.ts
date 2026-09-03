import http, { type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { broadcastNewJob, closeSocketServer, initSocketServer } from '../src/lib/socket.js';
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
});
