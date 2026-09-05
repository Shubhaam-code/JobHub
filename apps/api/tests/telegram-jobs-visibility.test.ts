/**
 * Which jobs `/api/v1/jobs` lists, per source.
 *
 * The rule under test: apply-link verification decides whether a card can offer an
 * Apply button, never whether the posting is listed. Requiring `applyUrlVerified`
 * in the feed query removed whole Telegram postings from the site while background
 * discovery was still pending, which is what these tests now pin down.
 *
 * Mocked at the model boundary, like every other route test here. The earlier
 * version of this file called `connectDatabase()` and `JobModel.deleteMany({})` in
 * `beforeEach` — against whatever `MONGODB_URI` points at, which in this repo is
 * the live cluster. Running the suite emptied the real `jobs` collection. A test
 * must never be able to do that, so there is no connection here at all.
 */

import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { GITHUB_SOURCE } from '../src/github/sync.js';
import { JobModel } from '../src/models/job.model.js';
import { queryDocs } from './helpers/mongo-filter.js';

const app = createApp();

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

let nextMessageId = 1000;

/** A stored job document, with only the fields a case cares about spelled out. */
function stored(overrides: Record<string, unknown>): Record<string, unknown> {
  nextMessageId += 1;

  return {
    _id: new mongoose.Types.ObjectId(),
    company: 'Example Co',
    role: 'Software Engineer',
    batch: '2027',
    applyUrl: null,
    applyUrlVerified: false,
    location: 'Remote',
    employmentType: 'full-time',
    source: 'telegram',
    telegramChannel: 'jobs_and_internships_updates',
    telegramMessageId: nextMessageId,
    originalText: 'Software Engineer at Example Co',
    cleanedText: 'Software Engineer at Example Co',
    postedAt: daysAgo(1),
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    status: 'active',
    expiresAt: null,
    ...overrides,
  };
}

/**
 * Serves `docs` through an in-memory evaluation of the route's own filter.
 *
 * The filter is applied rather than ignored, so a case asserting that a job is
 * listed is really asserting that the query admits it.
 */
function mockFeed(docs: Record<string, unknown>[]): void {
  vi.spyOn(JobModel, 'find').mockImplementation(((filter: Record<string, unknown>) => {
    const matched = queryDocs(docs, filter);

    return {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockResolvedValue(matched),
    };
  }) as never);

  vi.spyOn(JobModel, 'countDocuments').mockImplementation((async (
    filter: Record<string, unknown>,
  ) => queryDocs(docs, filter).length) as never);
}

/** Company names in the response, in order. */
function companiesIn(body: { data: { company: string }[] }): string[] {
  return body.data.map((job) => job.company);
}

describe('GET /api/v1/jobs — which sources are listed', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('lists a Telegram job whose apply link is verified', async () => {
    mockFeed([
      stored({
        company: 'Verified Co',
        applyUrl: 'https://careers.verified.com/apply',
        applyUrlVerified: true,
        applyUrlStatus: 'verified',
      }),
    ]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(companiesIn(response.body)).toEqual(['Verified Co']);
    expect(response.body.data[0].applyUrl).toBe('https://careers.verified.com/apply');
  });

  it('lists a Telegram job whose apply link is still pending discovery', async () => {
    mockFeed([
      stored({ company: 'Pending Co', applyUrl: null, applyUrlStatus: 'pending' }),
    ]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    /* The regression: this posting used to vanish from the site entirely because
       discovery had not finished. Company, role and description are worth reading
       now; the Apply button is the card's problem, and it has `applyUrlVerified`
       to decide with. */
    expect(companiesIn(response.body)).toEqual(['Pending Co']);
    expect(response.body.data[0].applyUrlVerified).toBe(false);
    expect(response.body.data[0].applyUrl).toBeNull();
  });

  it('lists a legacy Telegram row that predates the verification fields', async () => {
    mockFeed([
      stored({
        company: 'Legacy Co',
        applyUrl: 'https://careers.legacy-co.com/apply',
        // Written before these fields existed: absent, not false.
        applyUrlVerified: undefined,
        applyUrlStatus: undefined,
      }),
    ]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(companiesIn(response.body)).toEqual(['Legacy Co']);
    expect(response.body.data[0].applyUrlVerified).toBe(false);
  });

  it('lists every normal source together, verified or not', async () => {
    mockFeed([
      stored({
        company: 'Telegram Co',
        applyUrl: 'https://careers.telegram-co.com/apply',
        applyUrlVerified: true,
        applyUrlStatus: 'verified',
        postedAt: daysAgo(1),
      }),
      stored({
        company: 'Unverified Telegram Co',
        applyUrl: null,
        applyUrlStatus: 'pending',
        postedAt: daysAgo(2),
      }),
      stored({
        company: 'API Source Co',
        source: 'api-import',
        sourceId: 'api-456',
        applyUrl: null,
        postedAt: daysAgo(3),
      }),
    ]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    // Nothing is filtered on verification, from any source.
    expect(companiesIn(response.body).sort()).toEqual([
      'API Source Co',
      'Telegram Co',
      'Unverified Telegram Co',
    ]);
  });

  it('keeps Global Internships out of this feed, and nothing else', async () => {
    mockFeed([
      stored({ company: 'Telegram Co', postedAt: daysAgo(1) }),
      stored({
        company: 'Global Internship Co',
        source: GITHUB_SOURCE,
        sourceId: 'gh-1',
        applyUrl: 'https://boards.greenhouse.io/global/jobs/1',
        applyUrlVerified: true,
        postedAt: daysAgo(1),
      }),
    ]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    /* Global Internships have their own page and their own date filters. This is
       the only source rule in the feed — it is about where a listing belongs, not
       about whether it is good enough to show. */
    expect(companiesIn(response.body)).toEqual(['Telegram Co']);
  });

  it('still hides an expired posting, whatever its source', async () => {
    mockFeed([
      stored({ company: 'Fresh Co', postedAt: daysAgo(1) }),
      stored({ company: 'Stale Co', postedAt: daysAgo(40) }),
      stored({ company: 'Closed Co', status: 'expired', postedAt: daysAgo(1) }),
    ]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(companiesIn(response.body)).toEqual(['Fresh Co']);
  });
});
