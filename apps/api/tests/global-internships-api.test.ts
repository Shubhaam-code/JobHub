import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import * as database from '../src/config/database.js';
import {
  GITHUB_ACTIVE_WINDOW_DAYS,
  GITHUB_SOURCE,
  githubSourceCutoff,
} from '../src/github/sync.js';
import { JobModel } from '../src/models/job.model.js';
import { queryDocs } from './helpers/mongo-filter.js';

const app = createApp();
const now = new Date('2026-09-05T12:00:00.000Z');

const docs = [
  {
    _id: new mongoose.Types.ObjectId(),
    company: 'Fresh Global',
    role: 'Software Engineer Intern',
    location: 'Remote',
    applyUrl: 'https://careers.example.com/fresh',
    companyLogoUrl: null,
    source: GITHUB_SOURCE,
    sourceId: 'fresh',
    githubFeedActive: true,
    status: 'active',
    postedAt: new Date('2026-09-01T00:00:00.000Z'),
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    cleanedText: 'Software Engineer Intern at Fresh Global',
    originalText: 'Software Engineer Intern at Fresh Global',
  },
  {
    _id: new mongoose.Types.ObjectId(),
    company: 'Twenty Day Global',
    role: 'Backend Intern',
    location: 'London',
    applyUrl: null,
    companyLogoUrl: null,
    source: GITHUB_SOURCE,
    sourceId: 'twenty',
    githubFeedActive: true,
    status: 'expired',
    postedAt: new Date('2026-08-16T00:00:00.000Z'),
    createdAt: new Date('2026-08-16T00:00:00.000Z'),
    updatedAt: new Date('2026-08-16T00:00:00.000Z'),
    cleanedText: 'Backend Intern at Twenty Day Global',
    originalText: 'Backend Intern at Twenty Day Global',
  },
  {
    _id: new mongoose.Types.ObjectId(),
    company: 'Old Global',
    role: 'QA Intern',
    location: 'Remote',
    applyUrl: 'https://careers.example.com/old',
    companyLogoUrl: null,
    source: GITHUB_SOURCE,
    sourceId: 'old',
    githubFeedActive: false,
    status: 'expired',
    postedAt: new Date('2026-08-10T00:00:00.000Z'),
    createdAt: new Date('2026-08-10T00:00:00.000Z'),
    updatedAt: new Date('2026-08-10T00:00:00.000Z'),
    cleanedText: 'QA Intern at Old Global',
    originalText: 'QA Intern at Old Global',
  },
];

function mockCollection() {
  const run = (filter: Record<string, unknown>) => {
    let matched = queryDocs(docs, filter);
    const chain = {
      sort: () => chain,
      skip: (count: number) => {
        matched = matched.slice(count);
        return chain;
      },
      limit: (count: number) => {
        matched = matched.slice(0, count);
        return chain;
      },
      lean: () => Promise.resolve(matched),
    };
    return chain;
  };

  vi.spyOn(JobModel, 'find').mockImplementation(((filter: Record<string, unknown>) =>
    run(filter)) as never);
  vi.spyOn(JobModel, 'countDocuments').mockImplementation(((filter: Record<string, unknown>) =>
    Promise.resolve(queryDocs(docs, filter).length)) as never);
  vi.spyOn(JobModel, 'findOne').mockImplementation(((filter: Record<string, unknown>) => ({
    lean: () => Promise.resolve(queryDocs(docs, filter)[0] ?? null),
  })) as never);
}

describe('GET /api/v1/global-internships', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(database, 'isDatabaseConnected').mockReturnValue(true);
    mockCollection();
  });

  it('uses the GitHub source and the source-date 21-day window', async () => {
    const response = await request(app).get('/api/v1/global-internships');

    expect(response.status).toBe(200);
    expect(response.body.data.map((job: { company: string }) => job.company)).toEqual([
      'Fresh Global',
      'Twenty Day Global',
    ]);
    expect(response.headers['cache-control']).toContain('stale-while-revalidate');
    expect(githubSourceCutoff(now).toISOString()).toBe('2026-08-15T00:00:00.000Z');
  });

  it('supports search and location filters without widening the source filter', async () => {
    const response = await request(app).get(
      '/api/v1/global-internships?search=backend&location=london',
    );

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].company).toBe('Twenty Day Global');
  });

  it('narrows to a single day when both ends of the window fall on it', async () => {
    const response = await request(app).get(
      '/api/v1/global-internships?postedFrom=2026-09-01T00:00:00.000Z&postedTo=2026-09-01T23:59:59.999Z',
    );

    expect(response.status).toBe(200);
    expect(response.body.data.map((job: { company: string }) => job.company)).toEqual([
      'Fresh Global',
    ]);
  });

  it('clamps a postedFrom older than the window instead of returning nothing', async () => {
    // 2026-07-01 predates the 21-day cutoff. The caller gets the window it is
    // allowed to see, not an empty page.
    const response = await request(app).get(
      '/api/v1/global-internships?postedFrom=2026-07-01T00:00:00.000Z',
    );

    expect(response.status).toBe(200);
    expect(response.body.data.map((job: { company: string }) => job.company)).toEqual([
      'Fresh Global',
      'Twenty Day Global',
    ]);
  });

  it('reports the window it will answer for, so a date picker can bound itself', async () => {
    const response = await request(app).get('/api/v1/global-internships');

    expect(response.status).toBe(200);
    expect(response.body.meta.activeWindowDays).toBe(GITHUB_ACTIVE_WINDOW_DAYS);
    expect(new Date(response.body.meta.windowStart).getTime()).toBe(
      githubSourceCutoff(new Date(response.body.meta.windowEnd)).getTime(),
    );
  });

  it('rejects a reversed range and an unparseable date', async () => {
    const reversed = await request(app).get(
      '/api/v1/global-internships?postedFrom=2026-09-03T00:00:00.000Z&postedTo=2026-09-01T00:00:00.000Z',
    );
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.message).toContain('postedFrom must not be later than postedTo');

    const unparseable = await request(app).get('/api/v1/global-internships?postedFrom=last-tuesday');
    expect(unparseable.status).toBe(400);
    expect(unparseable.body.error.message).toContain('postedFrom');
  });
});
