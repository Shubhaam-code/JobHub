/**
 * The admin boundary is the security requirement of this feature, so these tests
 * assert it from the outside: no token → 401, a normal USER → 403, an ADMIN →
 * 200, on every endpoint. Frontend route protection is not part of it.
 */

import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { signAuthToken } from '../src/lib/auth.js';
import { ChannelModel } from '../src/models/channel.model.js';
import { IngestQueueModel } from '../src/models/ingest-queue.model.js';
import { JobModel } from '../src/models/job.model.js';
import { UserModel, type UserRole } from '../src/models/user.model.js';
import { invalidateChannelStatusCache } from '../src/telegram/channel-registry.js';

const app = createApp();

const ADMIN_ENDPOINTS = [
  { method: 'get' as const, path: '/api/admin/channels' },
  { method: 'get' as const, path: '/api/admin/stats' },
  {
    method: 'patch' as const,
    path: '/api/admin/channels/64f1a2b3c4d5e6f7a8b9e001',
    body: { status: 'paused' },
  },
];

const adminId = new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9d001');
const userId = new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9d002');
const channelId = new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9e001');

/** Mocks the user lookup `requireAdmin` performs on every request. */
function mockCaller(role: UserRole): void {
  const id = role === 'ADMIN' ? adminId : userId;

  vi.spyOn(UserModel, 'findById').mockReturnValue({
    lean: vi.fn().mockResolvedValue({
      _id: id,
      email: role === 'ADMIN' ? 'admin@local' : 'user@local',
      role,
    }),
  } as unknown as ReturnType<typeof UserModel.findById>);
}

function tokenFor(role: UserRole): string {
  return signAuthToken({ userId: (role === 'ADMIN' ? adminId : userId).toString(), role }).token;
}

const registryDocs = [
  {
    _id: channelId,
    username: 'internfreak',
    usernameKey: 'internfreak',
    title: 'Intern Freak',
    telegramId: '-1001234567890',
    isActive: true,
    pausedAt: null,
    lastMessageId: 5310,
    lastSyncedAt: new Date('2026-08-31T09:05:00.000Z'),
  },
  {
    _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9e002'),
    username: 'jia_test_paused',
    usernameKey: 'jia_test_paused',
    isActive: false,
    pausedAt: new Date('2026-08-30T12:00:00.000Z'),
  },
];

const queueStatRows = [
  {
    _id: 'internfreak',
    messagesReceived: 12,
    jobsExtracted: 7,
    jobsProcessed: 10,
    messagesPending: 1,
    messagesFailed: 1,
    lastMessageAt: new Date('2026-08-31T09:00:00.000Z'),
  },
];

const queueStatusRows = [
  { _id: 'pending', count: 1 },
  { _id: 'completed', count: 10 },
  { _id: 'failed', count: 1 },
];

const jobCountRows = [{ _id: 'internfreak', count: 7 }];

/** Wires up every collection read the admin routes perform. */
function mockRegistryReads(docs: unknown[] = registryDocs): void {
  vi.spyOn(ChannelModel, 'find').mockReturnValue({
    lean: vi.fn().mockResolvedValue(docs),
  } as unknown as ReturnType<typeof ChannelModel.find>);

  // Two different pipelines run against ingest_queue: per-channel stats and the
  // queue's own status counts. They are told apart by their $group key.
  vi.spyOn(IngestQueueModel, 'aggregate').mockImplementation(((pipeline: unknown[]) => {
    const group = (pipeline[0] as { $group?: { _id?: unknown } } | undefined)?.$group;
    const rows = group?._id === '$status' ? queueStatusRows : queueStatRows;

    return { exec: vi.fn().mockResolvedValue(rows) };
  }) as never);

  vi.spyOn(JobModel, 'aggregate').mockReturnValue({
    exec: vi.fn().mockResolvedValue(jobCountRows),
  } as never);

  vi.spyOn(IngestQueueModel, 'distinct').mockResolvedValue(['internfreak'] as never);
  vi.spyOn(JobModel, 'distinct').mockResolvedValue(['internfreak'] as never);
}

describe('admin API access control', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateChannelStatusCache();
  });

  it.each(ADMIN_ENDPOINTS)('1. $method $path → 401 without a token', async (endpoint) => {
    const response = await request(app)[endpoint.method](endpoint.path).send(endpoint.body);

    expect(response.status).toBe(401);
    expect(response.body.data).toBeUndefined();
  });

  it.each(ADMIN_ENDPOINTS)('2. $method $path → 401 with a garbage token', async (endpoint) => {
    const pending = request(app)[endpoint.method](endpoint.path);

    const response = await pending
      .set('Authorization', 'Bearer not.a.real.token')
      .send(endpoint.body);

    expect(response.status).toBe(401);
  });

  it.each(ADMIN_ENDPOINTS)('3. $method $path → 403 for a normal USER', async (endpoint) => {
    mockCaller('USER');
    mockRegistryReads();

    const pending = request(app)[endpoint.method](endpoint.path);

    const response = await pending
      .set('Authorization', `Bearer ${tokenFor('USER')}`)
      .send(endpoint.body);

    expect(response.status).toBe(403);
    expect(response.body.error.statusCode).toBe(403);
    // Nothing about the channels leaks through the rejection.
    expect(JSON.stringify(response.body)).not.toMatch(/internfreak/i);
  });

  it('4. returns 403 for a USER whose token claims ADMIN', async () => {
    mockCaller('USER');
    mockRegistryReads();

    // Signed correctly, but the stored role is what counts.
    const token = signAuthToken({ userId: userId.toString(), role: 'ADMIN' }).token;

    const response = await request(app)
      .get('/api/admin/channels')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
  });
});

describe('GET /api/admin/channels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateChannelStatusCache();
  });

  it('5. lists every channel with its derived statistics', async () => {
    mockCaller('ADMIN');
    mockRegistryReads();

    const response = await request(app)
      .get('/api/admin/channels')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(response.status).toBe(200);

    const channels = response.body.data as Record<string, unknown>[];
    const internfreak = channels.find((channel) => channel['username'] === 'internfreak');

    expect(internfreak).toEqual({
      id: channelId.toString(),
      name: 'Intern Freak',
      username: 'internfreak',
      telegramId: '-1001234567890',
      status: 'active',
      configured: expect.any(Boolean),
      messagesReceived: 12,
      jobsExtracted: 7,
      jobsProcessed: 10,
      messagesPending: 1,
      messagesFailed: 1,
      jobsInDatabase: 7,
      lastMessageAt: '2026-08-31T09:00:00.000Z',
      lastSyncAt: '2026-08-31T09:05:00.000Z',
      pausedAt: null,
    });
  });

  it('6. reports a paused channel as paused, with zeroed-but-present counters', async () => {
    mockCaller('ADMIN');
    mockRegistryReads();

    const response = await request(app)
      .get('/api/admin/channels')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const paused = (response.body.data as Record<string, unknown>[]).find(
      (channel) => channel['username'] === 'jia_test_paused',
    );

    expect(paused).toMatchObject({
      status: 'paused',
      pausedAt: '2026-08-30T12:00:00.000Z',
      messagesReceived: 0,
      jobsInDatabase: 0,
    });
  });

  it('7. names @username when Telegram has not reported a title', async () => {
    mockCaller('ADMIN');
    mockRegistryReads();

    const response = await request(app)
      .get('/api/admin/channels')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    const paused = (response.body.data as Record<string, unknown>[]).find(
      (channel) => channel['username'] === 'jia_test_paused',
    );

    expect(paused?.['name']).toBe('@jia_test_paused');
  });

  it('8. includes a channel that only exists in stored data', async () => {
    mockCaller('ADMIN');
    mockRegistryReads([]);

    const response = await request(app)
      .get('/api/admin/channels')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(response.status).toBe(200);

    const orphan = (response.body.data as Record<string, unknown>[]).find(
      (channel) => channel['username'] === 'internfreak',
    );

    // No registry document, so no id to pause — but its history is still visible.
    expect(orphan).toMatchObject({ id: null, messagesReceived: 12, jobsInDatabase: 7 });
  });
});

describe('GET /api/admin/stats', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateChannelStatusCache();
  });

  it('9. totals the same numbers the channel table shows', async () => {
    mockCaller('ADMIN');
    mockRegistryReads();

    const response = await request(app)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`);

    expect(response.status).toBe(200);

    const { data } = response.body;
    expect(data.channels.paused).toBe(1);
    expect(data.channels.total).toBeGreaterThanOrEqual(2);
    expect(data.messages).toMatchObject({
      received: 12,
      processed: 10,
      pending: 1,
      failed: 1,
    });
    expect(data.jobs).toEqual({ extracted: 7, inDatabase: 7 });
    expect(data.queue).toMatchObject({ pending: 1, completed: 10, failed: 1, total: 12 });
    expect(data.lastMessageAt).toBe('2026-08-31T09:00:00.000Z');
    expect(typeof data.ingestion.queueWorkerEnabled).toBe('boolean');
  });
});

describe('PATCH /api/admin/channels/:id', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateChannelStatusCache();
  });

  it('10. pauses a channel without deleting anything', async () => {
    mockCaller('ADMIN');
    mockRegistryReads();

    const updateSpy = vi.spyOn(ChannelModel, 'findByIdAndUpdate').mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        ...registryDocs[0],
        isActive: false,
        pausedAt: new Date('2026-08-31T10:00:00.000Z'),
      }),
    } as unknown as ReturnType<typeof ChannelModel.findByIdAndUpdate>);

    const jobDeleteMany = vi.spyOn(JobModel, 'deleteMany');
    const jobDeleteOne = vi.spyOn(JobModel, 'deleteOne');
    const queueDeleteMany = vi.spyOn(IngestQueueModel, 'deleteMany');

    const response = await request(app)
      .patch(`/api/admin/channels/${channelId.toString()}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'paused' });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      username: 'internfreak',
      status: 'paused',
      pausedAt: '2026-08-31T10:00:00.000Z',
      // History survives the pause.
      messagesReceived: 12,
      jobsInDatabase: 7,
    });

    // Only the two status fields are written.
    const [, update] = updateSpy.mock.calls[0] ?? [];
    expect(update).toEqual({ $set: { isActive: false, pausedAt: expect.any(Date) } });

    expect(jobDeleteMany).not.toHaveBeenCalled();
    expect(jobDeleteOne).not.toHaveBeenCalled();
    expect(queueDeleteMany).not.toHaveBeenCalled();
  });

  it('11. resumes a channel and clears pausedAt', async () => {
    mockCaller('ADMIN');
    mockRegistryReads();

    const updateSpy = vi.spyOn(ChannelModel, 'findByIdAndUpdate').mockReturnValue({
      lean: vi.fn().mockResolvedValue({ ...registryDocs[0], isActive: true, pausedAt: null }),
    } as unknown as ReturnType<typeof ChannelModel.findByIdAndUpdate>);

    const response = await request(app)
      .patch(`/api/admin/channels/${channelId.toString()}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'active' });

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('active');
    expect(response.body.data.pausedAt).toBeNull();

    const [, update] = updateSpy.mock.calls[0] ?? [];
    expect(update).toEqual({ $set: { isActive: true, pausedAt: null } });
  });

  it('12. rejects an unknown status with 400', async () => {
    mockCaller('ADMIN');
    const updateSpy = vi.spyOn(ChannelModel, 'findByIdAndUpdate');

    for (const body of [{ status: 'disabled' }, { status: '' }, {}, { active: true }]) {
      const response = await request(app)
        .patch(`/api/admin/channels/${channelId.toString()}`)
        .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
        .send(body);

      expect(response.status).toBe(400);
    }

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('13. rejects a malformed id with 400', async () => {
    mockCaller('ADMIN');

    const response = await request(app)
      .patch('/api/admin/channels/not-an-object-id')
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'paused' });

    expect(response.status).toBe(400);
  });

  it('14. returns 404 for a channel that does not exist', async () => {
    mockCaller('ADMIN');
    mockRegistryReads();

    vi.spyOn(ChannelModel, 'findByIdAndUpdate').mockReturnValue({
      lean: vi.fn().mockResolvedValue(null),
    } as unknown as ReturnType<typeof ChannelModel.findByIdAndUpdate>);

    const response = await request(app)
      .patch(`/api/admin/channels/${new mongoose.Types.ObjectId().toString()}`)
      .set('Authorization', `Bearer ${tokenFor('ADMIN')}`)
      .send({ status: 'paused' });

    expect(response.status).toBe(404);
  });
});
