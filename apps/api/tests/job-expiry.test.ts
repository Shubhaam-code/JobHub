import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { hashProfileToken } from '../src/lib/profile-token.js';
import { CandidateProfileModel } from '../src/models/candidate-profile.model.js';
import {
  JOB_ACTIVE_WINDOW_DAYS,
  jobExpiryFrom,
  JobModel,
  type JobStatus,
} from '../src/models/job.model.js';
import { queryDocs } from './helpers/mongo-filter.js';

/**
 * The 21-day window, tested through the endpoints rather than by reading the
 * filter back.
 *
 * `mockCollection` answers every query by running the filter the route actually
 * built against the fixtures, so a case fails if the rule is wrong — not merely
 * if the query is shaped differently than expected. Fixtures are dated relative
 * to now, so what is under test is the rule and not the calendar.
 */

const app = createApp();

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const daysAhead = (days: number) => new Date(Date.now() + days * DAY_MS);

const PROFILE_TOKEN = 'e'.repeat(64);

/** Matches the fixtures' role text, so an unexpired one is recommendable. */
const PROFILE_FIELDS = {
  tokenHash: hashProfileToken(PROFILE_TOKEN),
  skills: ['Java', 'Spring Boot', 'MongoDB'],
  preferredRoles: ['Backend Developer'],
  preferredLocations: ['Bengaluru'],
  preferredJobTypes: ['internship'],
  experienceYears: 0,
  graduationYear: '2026',
  manualFields: [],
};

const BASE = {
  role: 'Backend Developer Intern',
  batch: '2026',
  applyUrl: 'https://careers.example.com/apply',
  location: 'Bengaluru',
  employmentType: 'internship',
  source: 'telegram',
  telegramChannel: 'jobs_and_internships_updates',
  telegramChannelId: '-1001',
  telegramMessageUrl: null,
  originalText: 'Backend Developer Intern, Bengaluru. Java, Spring Boot, MongoDB.',
  cleanedText: 'Backend Developer Intern, Bengaluru. Java, Spring Boot and MongoDB. Freshers welcome.',
};

let nextMessageId = 900;

/** A stored job as the model writes one: active, expiring 21 days after creation. */
function stored(fields: {
  company: string;
  createdAt: Date;
  status?: JobStatus;
  expiresAt?: Date;
}): Record<string, unknown> {
  nextMessageId += 1;

  return {
    ...BASE,
    _id: new mongoose.Types.ObjectId(),
    company: fields.company,
    telegramMessageId: nextMessageId,
    postedAt: fields.createdAt,
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
    status: fields.status ?? 'active',
    expiresAt: fields.expiresAt ?? jobExpiryFrom(fields.createdAt),
  };
}

/**
 * The same row as it looked before the lifecycle fields existed: neither key is
 * present, which is the case the filter's null branches are there for.
 */
function storedLegacy(fields: { company: string; createdAt: Date }): Record<string, unknown> {
  const doc = stored(fields);
  delete doc['status'];
  delete doc['expiresAt'];
  return doc;
}

/** Yesterday's post: nearly three weeks of shelf life left. */
const freshJob = stored({ company: 'Fresh Co', createdAt: daysAgo(1) });

/** Ingested past the window, so its expiry is behind us. */
const staleJob = stored({
  company: 'Stale Co',
  createdAt: daysAgo(JOB_ACTIVE_WINDOW_DAYS + 4),
});

const legacyRecentJob = storedLegacy({ company: 'Legacy Recent', createdAt: daysAgo(3) });
const legacyStaleJob = storedLegacy({
  company: 'Legacy Stale',
  createdAt: daysAgo(JOB_ACTIVE_WINDOW_DAYS + 9),
});

/** The source says the role is filled, well inside the 21 days. */
const closedJob = stored({
  company: 'Closed Co',
  createdAt: daysAgo(2),
  status: 'closed',
  expiresAt: daysAhead(19),
});

/** A deadline the source published, already passed, inside the 21 days. */
const sourceDeadlineJob = stored({
  company: 'Deadline Co',
  createdAt: daysAgo(2),
  expiresAt: daysAgo(1),
});

/**
 * Answers `JobModel` reads out of `docs` by running the filter the route built.
 *
 * `sort` is a no-op: which documents come back is the subject here, and ordering
 * is covered in `jobs-api.test.ts`.
 */
function mockCollection(docs: Record<string, unknown>[]) {
  const runQuery = (filter: Record<string, unknown>) => {
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

  vi.spyOn(JobModel, 'find').mockImplementation(((filter: Record<string, unknown> = {}) =>
    runQuery(filter)) as never);
  vi.spyOn(JobModel, 'countDocuments').mockImplementation(((filter: Record<string, unknown> = {}) =>
    Promise.resolve(queryDocs(docs, filter).length)) as never);
  vi.spyOn(JobModel, 'findOne').mockImplementation(((filter: Record<string, unknown> = {}) => ({
    lean: () => Promise.resolve(queryDocs(docs, filter)[0] ?? null),
  })) as never);
}

function mockProfile() {
  return vi
    .spyOn(CandidateProfileModel, 'findOne')
    .mockResolvedValue(new CandidateProfileModel(PROFILE_FIELDS) as never);
}

const companiesOf = (body: { data: { company: string }[] }) => body.data.map((job) => job.company);

const idOf = (doc: Record<string, unknown>) => (doc['_id'] as mongoose.Types.ObjectId).toString();

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('the expiry window itself', () => {
  it('is 21 days after creation, to the millisecond', () => {
    expect(JOB_ACTIVE_WINDOW_DAYS).toBe(21);
    expect(jobExpiryFrom(new Date('2026-08-01T09:30:00.000Z')).toISOString()).toBe(
      '2026-08-22T09:30:00.000Z',
    );
  });
});

describe('GET /api/v1/jobs — 21-day expiry', () => {
  it('returns a fresh listing and withholds one past its window', async () => {
    mockCollection([freshJob, staleJob]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(companiesOf(response.body)).toEqual(['Fresh Co']);
  });

  it('counts only visible listings, so the pagination describes the live feed', async () => {
    mockCollection([freshJob, staleJob, closedJob, sourceDeadlineJob]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
  });

  it('measures the same window from createdAt for rows stored without expiresAt', async () => {
    mockCollection([legacyRecentJob, legacyStaleJob]);

    const response = await request(app).get('/api/v1/jobs');

    expect(response.status).toBe(200);
    expect(companiesOf(response.body)).toEqual(['Legacy Recent']);
  });

  it('hides a listing the source has closed, even with its window still open', async () => {
    mockCollection([freshJob, closedJob]);

    const response = await request(app).get('/api/v1/jobs');

    expect(companiesOf(response.body)).toEqual(['Fresh Co']);
  });

  it('respects a source deadline that falls before the 21 days are up', async () => {
    mockCollection([freshJob, sourceDeadlineJob]);

    const response = await request(app).get('/api/v1/jobs');

    expect(companiesOf(response.body)).toEqual(['Fresh Co']);
  });

  it('does not reach an expired listing through search', async () => {
    mockCollection([freshJob, staleJob]);

    const hit = await request(app).get('/api/v1/jobs?search=Stale');
    expect(hit.status).toBe(200);
    expect(hit.body.data).toEqual([]);
    expect(hit.body.pagination.total).toBe(0);

    // The same query shape does find the listing that is still on show.
    const fresh = await request(app).get('/api/v1/jobs?search=Fresh');
    expect(companiesOf(fresh.body)).toEqual(['Fresh Co']);
  });

  it('does not reach an expired listing through the batch or type filters', async () => {
    mockCollection([freshJob, staleJob]);

    const byBatch = await request(app).get('/api/v1/jobs?batch=2026');
    expect(companiesOf(byBatch.body)).toEqual(['Fresh Co']);

    const byType = await request(app).get('/api/v1/jobs?type=internship');
    expect(companiesOf(byType.body)).toEqual(['Fresh Co']);
  });

  it('keeps expired documents in the collection — hiding is not deleting', async () => {
    mockCollection([freshJob, staleJob, legacyStaleJob]);
    const deleteOne = vi.spyOn(JobModel, 'deleteOne');
    const deleteMany = vi.spyOn(JobModel, 'deleteMany');
    const updateMany = vi.spyOn(JobModel, 'updateMany');

    await request(app).get('/api/v1/jobs');

    expect(deleteOne).not.toHaveBeenCalled();
    expect(deleteMany).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/jobs/:id — 21-day expiry', () => {
  it('serves a listing that is still on show', async () => {
    mockCollection([freshJob, staleJob]);

    const response = await request(app).get(`/api/v1/jobs/${idOf(freshJob)}`);

    expect(response.status).toBe(200);
    expect(response.body.data.company).toBe('Fresh Co');
  });

  it('answers 404 for a listing past its window, even by direct link', async () => {
    mockCollection([freshJob, staleJob]);

    const response = await request(app).get(`/api/v1/jobs/${idOf(staleJob)}`);

    expect(response.status).toBe(404);
    expect(response.body.error.message).toContain('Job not found');
  });

  it('answers 404 for a closed listing and for an expired legacy row', async () => {
    mockCollection([closedJob, legacyStaleJob]);

    expect((await request(app).get(`/api/v1/jobs/${idOf(closedJob)}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/jobs/${idOf(legacyStaleJob)}`)).status).toBe(404);
  });
});

describe('GET /api/v1/jobs/recommended — 21-day expiry', () => {
  it('scores only the listings that are still on show', async () => {
    mockProfile();
    mockCollection([staleJob, freshJob, closedJob, legacyStaleJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${PROFILE_TOKEN}`);

    expect(response.status).toBe(200);
    // Every fixture shares the same matchable text, so anything withheld here
    // was withheld by the expiry filter and not by the score.
    expect(response.body.meta.considered).toBe(1);
    expect(
      response.body.data.map((entry: { job: { company: string } }) => entry.job.company),
    ).toEqual(['Fresh Co']);
  });
});
