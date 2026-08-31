import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { JobModel } from '../src/models/job.model.js';
import { normalizeMessage } from '../src/telegram/normalize.js';

const app = createApp();

type FindMock = ReturnType<typeof JobModel.find>;
type FindOneMock = ReturnType<typeof JobModel.findOne>;

/**
 * The two clauses every user-facing job query starts with: active status, and an
 * expiry still ahead (see `activeJobClauses`). Spelled out here rather than
 * imported from the model, so changing the visibility rule has to be restated in
 * the tests instead of being silently absorbed by them.
 */
const ACTIVE_CLAUSES = [
  { $or: [{ status: 'active' }, { status: null }] },
  {
    $or: [
      { expiresAt: { $gt: expect.any(Date) } },
      { expiresAt: null, createdAt: { $gt: expect.any(Date) } },
    ],
  },
];

/** Provenance the public API must never echo back. */
const TELEGRAM_FIELDS = [
  'source',
  'telegramChannel',
  'telegramChannelId',
  'telegramMessageId',
  'telegramMessageUrl',
  'originalText',
  'cleanedText',
] as const;

const sampleJob1 = {
  _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9c001'),
  company: 'Unisys',
  role: 'AI Engineering Intern',
  batch: '2027',
  applyUrl: 'https://example.com/apply-1',
  source: 'telegram',
  telegramChannel: 'jobs_and_internships_updates',
  telegramMessageId: 101,
  telegramMessageUrl: 'https://t.me/jobs_and_internships_updates/101',
  originalText:
    'Company: Unisys\nRole: AI Engineering Intern\n\nJoin @jobs_and_internships_updates',
  cleanedText: 'Company: Unisys\nRole: AI Engineering Intern',
  postedAt: new Date('2026-08-30T10:00:00.000Z'),
  createdAt: new Date('2026-08-30T10:00:05.000Z'),
  updatedAt: new Date('2026-08-30T10:00:05.000Z'),
};

const sampleJob2 = {
  _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9c002'),
  company: 'Google',
  role: 'Software Engineer',
  batch: '2026',
  applyUrl: 'https://careers.google.com/jobs/123',
  source: 'telegram',
  telegramChannel: 'jobs_and_internships_updates',
  telegramMessageId: 102,
  telegramMessageUrl: 'https://t.me/jobs_and_internships_updates/102',
  originalText: 'Company: Google\nRole: Software Engineer',
  cleanedText: 'Company: Google\nRole: Software Engineer',
  postedAt: new Date('2026-08-31T08:00:00.000Z'),
  createdAt: new Date('2026-08-31T08:00:05.000Z'),
  updatedAt: new Date('2026-08-31T08:00:05.000Z'),
};

/**
 * A row from before `cleanedText` existed, with an apply link pointing at the
 * source channel. Both have to be scrubbed on read.
 */
const legacyJob = {
  _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9c003'),
  company: 'Infobip',
  role: 'Solution Engineer Intern',
  batch: '2027',
  applyUrl: 'https://t.me/internfreak/5310',
  source: 'telegram',
  telegramChannel: 'internfreak',
  telegramMessageId: 5310,
  telegramMessageUrl: 'https://t.me/internfreak/5310',
  originalText:
    'Company: Infobip\nRole: Solution Engineer Intern\n\n' +
    'Join @internfreak for more updates: https://t.me/internfreak',
  postedAt: new Date('2026-08-31T09:00:00.000Z'),
  createdAt: new Date('2026-08-31T09:00:05.000Z'),
  updatedAt: new Date('2026-08-31T09:00:05.000Z'),
};

function createMockFindQuery(results: unknown[]) {
  const query = {
    sort: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(results),
  };
  return query;
}

function createMockFindOneQuery(result: unknown) {
  const query = {
    lean: vi.fn().mockResolvedValue(result),
  };
  return query;
}

describe('GET /api/v1/jobs', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. returns jobs with default pagination and public fields', async () => {
    const mockQuery = createMockFindQuery([sampleJob2, sampleJob1]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(2);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(response.body.pagination).toEqual({
      page: 1,
      limit: 20,
      total: 2,
      totalPages: 1,
    });
    expect(response.body.data).toHaveLength(2);
    expect(response.body.data[0]).toEqual({
      id: sampleJob2._id.toString(),
      company: 'Google',
      role: 'Software Engineer',
      batch: '2026',
      applyUrl: 'https://careers.google.com/jobs/123',
      location: null,
      employmentType: null,
      description: sampleJob2.cleanedText,
      postedAt: sampleJob2.postedAt.toISOString(),
      createdAt: sampleJob2.createdAt.toISOString(),
      updatedAt: sampleJob2.updatedAt.toISOString(),
    });
    expect(response.body.data[0]._id).toBeUndefined();
    expect(response.body.data[0].__v).toBeUndefined();
  });

  it('2. orders newest jobs first by postedAt', async () => {
    const mockQuery = createMockFindQuery([sampleJob2, sampleJob1]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(2);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(mockQuery.sort).toHaveBeenCalledWith({ postedAt: -1, _id: -1 });
    expect(response.body.data[0].id).toBe(sampleJob2._id.toString());
  });

  it('3. supports pagination (page=2, limit=1)', async () => {
    const mockQuery = createMockFindQuery([sampleJob1]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(5);

    const response = await request(app).get('/api/v1/jobs?page=2&limit=1');

    expect(response.status).toBe(200);
    expect(mockQuery.skip).toHaveBeenCalledWith(1);
    expect(mockQuery.limit).toHaveBeenCalledWith(1);
    expect(response.body.pagination).toEqual({
      page: 2,
      limit: 1,
      total: 5,
      totalPages: 5,
    });
    expect(response.body.data).toHaveLength(1);
  });

  it('4. respects limit parameter', async () => {
    const mockQuery = createMockFindQuery([sampleJob1]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(10);

    const response = await request(app).get('/api/v1/jobs?limit=5');

    expect(response.status).toBe(200);
    expect(mockQuery.limit).toHaveBeenCalledWith(5);
    expect(response.body.pagination.limit).toBe(5);
  });

  it('5. filters by search query on company or role', async () => {
    const mockQuery = createMockFindQuery([sampleJob1]);
    const findSpy = vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(1);

    const response = await request(app).get('/api/v1/jobs?search=unisys');

    expect(response.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith({
      $and: [...ACTIVE_CLAUSES, { $or: [{ company: expect.any(RegExp) }, { role: expect.any(RegExp) }] }],
    });
  });

  it('6. filters by batch query', async () => {
    const mockQuery = createMockFindQuery([sampleJob1]);
    const findSpy = vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(1);

    const response = await request(app).get('/api/v1/jobs?batch=2027');

    expect(response.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith({
      $and: [...ACTIVE_CLAUSES, { batch: expect.any(RegExp) }],
    });
  });

  it('6b. exposes no Telegram provenance on any job', async () => {
    const mockQuery = createMockFindQuery([sampleJob2, sampleJob1, legacyJob]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(3);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(3);

    for (const job of response.body.data as Record<string, unknown>[]) {
      for (const field of TELEGRAM_FIELDS) {
        expect(job[field]).toBeUndefined();
      }
    }

    // Nothing anywhere in the payload names a channel.
    expect(JSON.stringify(response.body)).not.toMatch(/t\.me|internfreak|jobs_and_internships/i);
  });

  it('6c. ignores a channel parameter instead of filtering by it', async () => {
    const mockQuery = createMockFindQuery([legacyJob]);
    const findSpy = vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(1);

    const response = await request(app).get('/api/v1/jobs?channel=@internfreak');

    expect(response.status).toBe(200);
    // No telegramChannel clause: a caller cannot probe for which channels exist.
    // The expiry clauses are all that narrows the query.
    expect(findSpy).toHaveBeenCalledWith({ $and: ACTIVE_CLAUSES });
  });

  it('6d. scrubs a legacy row that has no stored cleanedText', async () => {
    const mockQuery = createMockFindQuery([legacyJob]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(1);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);

    const job = response.body.data[0];
    expect(job.description).toBe(normalizeMessage(legacyJob.originalText).cleanedText);
    expect(job.description).toContain('Infobip');
    expect(job.description).not.toMatch(/internfreak|t\.me|@/i);
    // A t.me "apply" link would name the source channel on the card.
    expect(job.applyUrl).toBeNull();
  });

  it('7. handles empty results gracefully', async () => {
    const mockQuery = createMockFindQuery([]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(0);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [],
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      },
    });
  });

  it('11a. rejects negative or zero page number with 400', async () => {
    const response = await request(app).get('/api/v1/jobs?page=0');

    expect(response.status).toBe(400);
    expect(response.body.error.statusCode).toBe(400);
  });

  it('11b. rejects non-numeric page with 400', async () => {
    const response = await request(app).get('/api/v1/jobs?page=abc');

    expect(response.status).toBe(400);
    expect(response.body.error.statusCode).toBe(400);
  });

  it('11c. rejects limit greater than MAX_LIMIT (100) with 400', async () => {
    const response = await request(app).get('/api/v1/jobs?limit=101');

    expect(response.status).toBe(400);
    expect(response.body.error.statusCode).toBe(400);
  });

  it('11d. rejects negative limit with 400', async () => {
    const response = await request(app).get('/api/v1/jobs?limit=-5');

    expect(response.status).toBe(400);
    expect(response.body.error.statusCode).toBe(400);
  });
});

describe('GET /api/v1/jobs/channels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('6e. no longer publishes the channel list', async () => {
    const distinctSpy = vi.spyOn(JobModel, 'distinct');

    const response = await request(app).get('/api/v1/jobs/channels');

    // "channels" now falls through to /:id, which rejects it as an invalid id.
    expect(response.status).toBe(400);
    expect(response.body.data).toBeUndefined();
    expect(distinctSpy).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/jobs/:id', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('8. returns a single job by valid ID', async () => {
    const mockQuery = createMockFindOneQuery(sampleJob1);
    const findOneSpy = vi
      .spyOn(JobModel, 'findOne')
      .mockReturnValue(mockQuery as unknown as FindOneMock);

    const response = await request(app).get(`/api/v1/jobs/${sampleJob1._id.toString()}`);

    expect(response.status).toBe(200);
    // The id alone is not the lookup: a hidden listing must not answer to a
    // direct link either.
    expect(findOneSpy).toHaveBeenCalledWith({
      _id: sampleJob1._id.toString(),
      $and: ACTIVE_CLAUSES,
    });
    expect(response.body).toEqual({
      data: {
        id: sampleJob1._id.toString(),
        company: 'Unisys',
        role: 'AI Engineering Intern',
        batch: '2027',
        applyUrl: 'https://example.com/apply-1',
        location: null,
        employmentType: null,
        description: sampleJob1.cleanedText,
        postedAt: sampleJob1.postedAt.toISOString(),
        createdAt: sampleJob1.createdAt.toISOString(),
        updatedAt: sampleJob1.updatedAt.toISOString(),
      },
    });
  });

  it('9. returns 404 for a non-existent job ID', async () => {
    const mockQuery = createMockFindOneQuery(null);
    vi.spyOn(JobModel, 'findOne').mockReturnValue(mockQuery as unknown as FindOneMock);

    const nonExistentId = new mongoose.Types.ObjectId().toString();
    const response = await request(app).get(`/api/v1/jobs/${nonExistentId}`);

    expect(response.status).toBe(404);
    expect(response.body.error.statusCode).toBe(404);
    expect(response.body.error.message).toContain('Job not found');
  });

  it('10. returns 400 for an invalid MongoDB ID format', async () => {
    const response = await request(app).get('/api/v1/jobs/invalid-mongo-id-123');

    expect(response.status).toBe(400);
    expect(response.body.error.statusCode).toBe(400);
    expect(response.body.error.message).toContain('Invalid job ID');
  });
});
