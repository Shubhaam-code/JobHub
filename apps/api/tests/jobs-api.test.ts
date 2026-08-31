import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { JobModel } from '../src/models/job.model.js';
import { mergeChannelNames } from '../src/routes/jobs.route.js';

const app = createApp();

type FindMock = ReturnType<typeof JobModel.find>;
type FindByIdMock = ReturnType<typeof JobModel.findById>;

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
  originalText: 'Company: Unisys\nRole: AI Engineering Intern',
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
  postedAt: new Date('2026-08-31T08:00:00.000Z'),
  createdAt: new Date('2026-08-31T08:00:05.000Z'),
  updatedAt: new Date('2026-08-31T08:00:05.000Z'),
};

const sampleJob3 = {
  _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9c003'),
  company: 'Infobip',
  role: 'Solution Engineer Intern',
  batch: '2027',
  applyUrl: 'https://example.com/apply-3',
  source: 'telegram',
  telegramChannel: 'internfreak',
  telegramMessageId: 5310,
  telegramMessageUrl: 'https://t.me/internfreak/5310',
  originalText: 'Company: Infobip\nRole: Solution Engineer Intern',
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

function createMockFindByIdQuery(result: unknown) {
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
      source: 'telegram',
      telegramChannel: 'jobs_and_internships_updates',
      telegramMessageId: 102,
      telegramMessageUrl: 'https://t.me/jobs_and_internships_updates/102',
      originalText: sampleJob2.originalText,
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
    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: [{ company: expect.any(RegExp) }, { role: expect.any(RegExp) }],
      }),
    );
  });

  it('6. filters by batch query', async () => {
    const mockQuery = createMockFindQuery([sampleJob1]);
    const findSpy = vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(1);

    const response = await request(app).get('/api/v1/jobs?batch=2027');

    expect(response.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        batch: expect.any(RegExp),
      }),
    );
  });

  it('6b. filters by source channel and tolerates a leading "@"', async () => {
    const mockQuery = createMockFindQuery([sampleJob3]);
    const findSpy = vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(1);

    const response = await request(app).get('/api/v1/jobs?channel=@internfreak');

    expect(response.status).toBe(200);
    expect(findSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramChannel: /^internfreak$/i,
      }),
    );
  });

  it('6c. returns the real source channel of each job, not a default one', async () => {
    const mockQuery = createMockFindQuery([sampleJob3, sampleJob1]);
    vi.spyOn(JobModel, 'find').mockReturnValue(mockQuery as unknown as FindMock);
    vi.spyOn(JobModel, 'countDocuments').mockResolvedValue(2);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(response.body.data[0].telegramChannel).toBe('internfreak');
    expect(response.body.data[0].telegramMessageUrl).toBe('https://t.me/internfreak/5310');
    expect(response.body.data[1].telegramChannel).toBe('jobs_and_internships_updates');
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

  it('6d. lists the configured channels first, then stored-only channels A→Z', async () => {
    vi.spyOn(JobModel, 'distinct').mockResolvedValue([
      'jia_test_stored_b',
      'jia_test_stored_a',
    ] as never);

    const response = await request(app).get('/api/v1/jobs/channels');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [...env.telegramChannels, 'jia_test_stored_a', 'jia_test_stored_b'],
    });
  });

  it('6e. still lists a configured channel that has no stored jobs', async () => {
    vi.spyOn(JobModel, 'distinct').mockResolvedValue([] as never);

    const response = await request(app).get('/api/v1/jobs/channels');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: env.telegramChannels });
    expect(env.telegramChannels.length).toBeGreaterThan(0);
  });

  it('6f. dedupes configured and stored channels case-insensitively', () => {
    expect(mergeChannelNames(['HireMeFresh', 'jobs_SQL'], ['hiremefresh', 'internfreak'])).toEqual([
      'HireMeFresh',
      'jobs_SQL',
      'internfreak',
    ]);
  });

  it('6g. tolerates a leading @ and blank entries', () => {
    expect(mergeChannelNames(['@getjobss', '  '], ['@getjobss', ''])).toEqual(['getjobss']);
  });
});

describe('GET /api/v1/jobs/:id', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('8. returns a single job by valid ID', async () => {
    const mockQuery = createMockFindByIdQuery(sampleJob1);
    vi.spyOn(JobModel, 'findById').mockReturnValue(mockQuery as unknown as FindByIdMock);

    const response = await request(app).get(`/api/v1/jobs/${sampleJob1._id.toString()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        id: sampleJob1._id.toString(),
        company: 'Unisys',
        role: 'AI Engineering Intern',
        batch: '2027',
        applyUrl: 'https://example.com/apply-1',
        location: null,
        employmentType: null,
        source: 'telegram',
        telegramChannel: 'jobs_and_internships_updates',
        telegramMessageId: 101,
        telegramMessageUrl: 'https://t.me/jobs_and_internships_updates/101',
        originalText: sampleJob1.originalText,
        postedAt: sampleJob1.postedAt.toISOString(),
        createdAt: sampleJob1.createdAt.toISOString(),
        updatedAt: sampleJob1.updatedAt.toISOString(),
      },
    });
  });

  it('9. returns 404 for a non-existent job ID', async () => {
    const mockQuery = createMockFindByIdQuery(null);
    vi.spyOn(JobModel, 'findById').mockReturnValue(mockQuery as unknown as FindByIdMock);

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
