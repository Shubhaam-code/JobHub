import mongoose from 'mongoose';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import { hashProfileToken } from '../src/lib/profile-token.js';
import { CandidateProfileModel } from '../src/models/candidate-profile.model.js';
import { JobModel } from '../src/models/job.model.js';

const app = createApp();

const TOKEN = 'c'.repeat(64);

/** The candidate from the spec: Java backend intern, Bengaluru. */
const PROFILE_FIELDS = {
  tokenHash: hashProfileToken(TOKEN),
  skills: ['Java', 'Spring Boot', 'MongoDB'],
  preferredRoles: ['Backend Developer'],
  preferredLocations: ['Bengaluru'],
  preferredJobTypes: ['internship'],
  experienceYears: 0,
  graduationYear: '2026',
  manualFields: [],
};

const APPLY_URL = 'https://careers.example.com/apply/backend-intern?ref=xyz';

/** TEST 3's job: should score high. */
const matchingJob = {
  _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9d001'),
  company: 'Acme Fintech',
  role: 'Backend Developer Intern',
  batch: '2026',
  applyUrl: APPLY_URL,
  location: 'Bengaluru',
  employmentType: 'internship',
  source: 'telegram',
  telegramChannel: 'jobs_and_internships_updates',
  telegramChannelId: '-1001',
  telegramMessageId: 201,
  telegramMessageUrl: 'https://t.me/jobs_and_internships_updates/201',
  originalText: 'Join our channel! Backend Developer Intern at Acme Fintech.',
  cleanedText:
    'Backend Developer Intern at Acme Fintech, Bengaluru. Java, Spring Boot and MongoDB. Freshers welcome.',
  postedAt: new Date('2026-08-30T10:00:00.000Z'),
  createdAt: new Date('2026-08-30T10:00:05.000Z'),
  updatedAt: new Date('2026-08-30T10:00:05.000Z'),
};

/** TEST 4's job: should score low and be excluded. */
const irrelevantJob = {
  _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9d002'),
  company: 'Cupertino Apps',
  role: 'iOS Developer',
  batch: null,
  applyUrl: 'https://example.com/ios',
  location: 'New York',
  employmentType: 'full-time',
  source: 'telegram',
  telegramChannel: 'jobs_and_internships_updates',
  telegramChannelId: '-1001',
  telegramMessageId: 202,
  telegramMessageUrl: 'https://t.me/jobs_and_internships_updates/202',
  originalText: 'iOS Developer, New York. Swift and Objective-C, 3+ years.',
  cleanedText: 'iOS Developer, New York. Swift and Objective-C required, 3+ years experience.',
  postedAt: new Date('2026-08-31T10:00:00.000Z'),
  createdAt: new Date('2026-08-31T10:00:05.000Z'),
  updatedAt: new Date('2026-08-31T10:00:05.000Z'),
};

/** A weaker but still plausible match, for ordering checks. */
const partialJob = {
  ...matchingJob,
  _id: new mongoose.Types.ObjectId('64f1a2b3c4d5e6f7a8b9d003'),
  company: 'Beta Corp',
  role: 'Backend Developer',
  location: 'Bengaluru',
  employmentType: 'full-time',
  telegramMessageId: 203,
  cleanedText: 'Backend Developer at Beta Corp, Bengaluru. Java and PostgreSQL. 2+ years.',
  originalText: 'Backend Developer at Beta Corp',
  postedAt: new Date('2026-08-29T10:00:00.000Z'),
};

function mockJobs(docs: unknown[]) {
  return vi.spyOn(JobModel, 'find').mockReturnValue({
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    lean: vi.fn().mockResolvedValue(docs),
  } as never);
}

function mockProfile(overrides: Record<string, unknown> = {}) {
  return vi
    .spyOn(CandidateProfileModel, 'findOne')
    .mockResolvedValue(new CandidateProfileModel({ ...PROFILE_FIELDS, ...overrides }) as never);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('GET /api/v1/jobs/recommended', () => {
  it('TEST 7: requires a profile token and says so clearly', async () => {
    const response = await request(app).get('/api/v1/jobs/recommended');

    expect(response.status).toBe(401);
    expect(response.body.error.message).toContain('profile token');
  });

  it('is not shadowed by GET /jobs/:id', async () => {
    const response = await request(app).get('/api/v1/jobs/recommended');

    // A 401 proves the recommended handler ran; the :id route would 400 on the
    // invalid object id "recommended".
    expect(response.status).toBe(401);
    expect(response.body.error.message).not.toContain('job ID');
  });

  it('TEST 3: ranks a matching Java backend internship first, with reasons', async () => {
    mockProfile();
    mockJobs([irrelevantJob, matchingJob, partialJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);

    const top = response.body.data[0];
    expect(top.job.company).toBe('Acme Fintech');
    expect(top.matchScore).toBeGreaterThanOrEqual(80);
    expect(top.matchedSkills).toEqual(expect.arrayContaining(['Java', 'Spring Boot', 'MongoDB']));
    expect(top.reasons.join('\n')).toContain('matches your preferred location');
  });

  it('TEST 4: excludes the low-scoring iOS role', async () => {
    mockProfile();
    mockJobs([irrelevantJob, matchingJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    const companies = response.body.data.map((entry: { job: { company: string } }) => entry.job.company);
    expect(companies).not.toContain('Cupertino Apps');
  });

  it('returns results sorted by score, highest first', async () => {
    mockProfile();
    mockJobs([partialJob, matchingJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    const scores = response.body.data.map((entry: { matchScore: number }) => entry.matchScore);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
  });

  it('TEST 5: changing the location preference changes the results', async () => {
    mockProfile();
    mockJobs([matchingJob]);
    const before = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    vi.restoreAllMocks();
    mockProfile({ preferredLocations: ['Remote'] });
    mockJobs([matchingJob]);
    const after = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(after.body.data[0].matchScore).toBeLessThan(before.body.data[0].matchScore);
    expect(after.body.data[0].reasons.join()).not.toContain('preferred location');
  });

  it('TEST 6: returns the exact stored apply URL, unmodified', async () => {
    mockProfile();
    mockJobs([matchingJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.body.data[0].job.applyUrl).toBe(APPLY_URL);
  });

  it('reports gaps so a near miss is explainable', async () => {
    mockProfile();
    mockJobs([partialJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.body.data[0].gaps).toContain('PostgreSQL');
  });

  it('returns an empty list for an empty profile rather than inventing matches', async () => {
    mockProfile({
      skills: [],
      preferredRoles: [],
      preferredLocations: [],
      preferredJobTypes: [],
      experienceYears: null,
    });
    const find = mockJobs([matchingJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta.hasPreferences).toBe(false);
    // No point querying jobs when nothing can be compared.
    expect(find).not.toHaveBeenCalled();
  });

  it('returns an empty list when nothing clears the threshold', async () => {
    mockProfile();
    mockJobs([irrelevantJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.meta.hasPreferences).toBe(true);
  });

  it('reports the threshold in use so the client can explain itself', async () => {
    mockProfile();
    mockJobs([matchingJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.body.meta.minScore).toBe(env.RECOMMENDATION_MIN_SCORE);
  });

  it('never exposes provenance through a recommendation', async () => {
    mockProfile();
    mockJobs([matchingJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended')
      .set('Authorization', `Bearer ${TOKEN}`);

    const job = response.body.data[0].job;
    expect(job).not.toHaveProperty('telegramChannel');
    expect(job).not.toHaveProperty('telegramMessageUrl');
    expect(job).not.toHaveProperty('originalText');
    expect(job).not.toHaveProperty('source');
    // The promotional line from the raw post must not reach the client either.
    expect(JSON.stringify(response.body)).not.toContain('Join our channel');
  });

  it('honours the limit parameter', async () => {
    mockProfile();
    mockJobs([matchingJob, partialJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended?limit=1')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.body.data).toHaveLength(1);
  });

  it('rejects a malformed limit', async () => {
    mockProfile();
    mockJobs([matchingJob]);

    const response = await request(app)
      .get('/api/v1/jobs/recommended?limit=abc')
      .set('Authorization', `Bearer ${TOKEN}`);

    expect(response.status).toBe(400);
  });
});
