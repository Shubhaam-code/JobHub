import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activeJobFilter,
  JOB_ACTIVE_WINDOW_MS,
  JOB_SOURCE_ACTIVE_WINDOW_DAYS,
  JOB_SOURCE_ACTIVE_WINDOW_MS,
} from '../src/models/job.model.js';
import { resolveApplyUrlFields } from '../src/models/job.repository.js';
import {
  parseGithubReadme,
  sourceIdFor,
  syncGithubJobs,
  type GithubJobRow,
} from '../src/github/sync.js';
import { JobModel } from '../src/models/job.model.js';
import * as logo from '../src/telegram/company-logo.js';
import { enqueueDiscoveryJob } from '../src/apply-discovery/queue.js';
import { queryDocs } from './helpers/mongo-filter.js';

/**
 * The discovery queue writes to its own collection, which no test here connects
 * to. Mocked at the module boundary rather than spied on, so a row that needs
 * discovery records the call instead of waiting out Mongoose's buffering timeout.
 */
vi.mock('../src/apply-discovery/queue.js', () => ({
  enqueueDiscoveryJob: vi.fn(async () => ({ outcome: 'queued', discoveryJobId: 'test' })),
}));

const enqueueMock = vi.mocked(enqueueDiscoveryJob);

const README = `
## Source

| Company | Role | Posted | Applied | Link |
|---|---|---|---|---|
| Acme | Software Engineer Intern | 2026-09-05 | — | [Apply](https://jobs.example.com/acme/1) |
| No Link Co | Data Intern | 2026-09-04 | — | — |
| No Date Co | SWE Intern | — | — | [Apply](https://careers.nodate.example/jobs/2) |
| Broken | | 2026-09-05 | — | [Apply](not-a-url) |
`;

describe('parseGithubReadme', () => {
  it('extracts rows and tolerates missing dates and links', () => {
    const result = parseGithubReadme(README);

    expect(result.fetched).toBe(4);
    expect(result.rows).toHaveLength(3);
    expect(result.skipped).toBe(1);
    expect(result.hasJobTable).toBe(true);
    expect(result.rows[0]).toMatchObject({
      company: 'Acme',
      role: 'Software Engineer Intern',
      applyUrl: 'https://jobs.example.com/acme/1',
    });
    expect(result.rows[0]?.postedAt?.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect(result.rows[1]).toMatchObject({ company: 'No Link Co', applyUrl: null });
    expect(result.rows[2]).toMatchObject({ company: 'No Date Co', postedAt: null });
  });

  it('preserves job-identifying query parameters through the shared apply mapping', () => {
    const result = parseGithubReadme(
      '| Company | Role | Posted | Link |\n' +
        '|---|---|---|---|\n' +
        '| Acme | QA Intern | 2026-09-05 | [Apply](https://jobs.example.com/acme/1?jobId=42&locale=en) |',
    );
    const extracted = result.rows[0]?.applyUrl;

    expect(extracted).toBe('https://jobs.example.com/acme/1?jobId=42&locale=en');
    expect(resolveApplyUrlFields(extracted, { company: 'Acme' }).applyUrl).toBe(extracted);
  });
});

describe('GitHub source identities and active-date rule', () => {
  const row = (applyUrl: string | null): GithubJobRow => ({
    company: 'Acme',
    role: 'Software Engineer Intern',
    postedAt: new Date('2026-09-05T00:00:00.000Z'),
    applyUrl,
    raw: '',
  });

  it('uses a stable identity for the same application URL', () => {
    expect(sourceIdFor(row('https://jobs.example.com/acme/1'))).toBe(
      sourceIdFor(row('https://jobs.example.com/acme/1')),
    );
    expect(sourceIdFor(row('https://jobs.example.com/acme/1'))).not.toBe(
      sourceIdFor(row('https://jobs.example.com/acme/2')),
    );
  });

  it('does not merge distinct roles that share one application URL', () => {
    const sameUrl = 'https://jobs.example.com/acme/1';
    expect(sourceIdFor(row(sameUrl))).not.toBe(
      sourceIdFor({ ...row(sameUrl), role: 'Backend Engineer Intern' }),
    );
  });

  it('uses a calendar-day cutoff of 15 source days', () => {
    expect(JOB_SOURCE_ACTIVE_WINDOW_DAYS).toBe(15);
    expect(JOB_SOURCE_ACTIVE_WINDOW_MS).toBe(15 * 24 * 60 * 60 * 1000);

    const now = new Date('2026-09-05T12:00:00.000Z');
    const filter = activeJobFilter(now);
    const docs = [
      { postedAt: new Date('2026-09-05T00:00:00.000Z'), createdAt: new Date('2026-09-05T00:00:00.000Z'), status: 'active' },
      { postedAt: new Date('2026-08-21T23:59:59.000Z'), createdAt: new Date('2026-09-05T00:00:00.000Z'), status: 'active' },
      { postedAt: new Date('2026-08-20T23:59:59.000Z'), createdAt: new Date('2026-09-05T00:00:00.000Z'), status: 'active' },
      // Imported today, but the source says it was posted 20 days ago.
      { postedAt: new Date('2026-08-16T00:00:00.000Z'), createdAt: new Date('2026-09-05T00:00:00.000Z'), status: 'active' },
    ];

    expect(queryDocs(docs, filter)).toHaveLength(2);
  });
});

describe('syncGithubJobs', () => {
  const stored = new Map<string, Record<string, unknown>>();

  const chain = (value: unknown) => ({
    select: () => chain(value),
    lean: () => Promise.resolve(value),
  });

  beforeEach(() => {
    stored.clear();
    vi.restoreAllMocks();
    // Re-armed after the restore above, which clears the factory's implementation.
    enqueueMock.mockImplementation(async () => ({ outcome: 'queued', discoveryJobId: 'test' }));
    vi.spyOn(logo, 'findCompanyLogoUrl').mockResolvedValue(null);
    vi.spyOn(JobModel, 'findOne').mockImplementation(((filter: Record<string, unknown>) => {
      if ('companyLogoUrl' in filter) return chain(null) as never;
      return chain(stored.get(String(filter.sourceId)) ?? null) as never;
    }) as never);
    vi.spyOn(JobModel, 'create').mockImplementation((async (fields: Record<string, unknown>) => {
      const doc = { ...fields, _id: new mongoose.Types.ObjectId() };
      stored.set(String(fields.sourceId), doc);
      return doc;
    }) as never);
    vi.spyOn(JobModel, 'updateOne').mockImplementation((async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const doc = stored.get(String(filter.sourceId)) ?? [...stored.values()].find((entry) => entry._id === filter._id);
      if (!doc) return { modifiedCount: 0 } as never;
      Object.assign(doc, update.$set ?? {});
      return { modifiedCount: 1 } as never;
    }) as never);
    vi.spyOn(JobModel, 'find').mockImplementation((() => chain([...stored.values()])) as never);
  });

  it('does not duplicate a job when the same README is synced twice', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(README, { status: 200 }));
    const options = {
      fetchImpl,
      now: new Date('2026-09-05T12:00:00.000Z'),
      readmeUrl: 'https://example.test/README.md',
    };

    const first = await syncGithubJobs(options);
    const second = await syncGithubJobs(options);

    expect(first.created).toBe(2);
    expect(second.created).toBe(0);
    expect(stored.size).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('queues apply discovery for a row with no usable link, and not for one that verified', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const readme = `
| Company | Role | Posted | Link |
|---|---|---|---|
| Acme | Software Engineer Intern | 2026-09-05 | [Apply](https://jobs.example.com/acme/1) |
| No Link Co | Data Intern | 2026-09-05 | - |
`;

    await syncGithubJobs({
      fetchImpl: vi.fn().mockResolvedValue(new Response(readme, { status: 200 })),
      now,
      readmeUrl: 'https://example.test/README.md',
    });

    /* This source writes through JobModel rather than saveJob(), so without the
       explicit enqueue the linkless row would stay unverified forever. The row that
       already has a direct link needs nothing — spending discovery on it would be
       pure cost. */
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0]?.[0]).toMatchObject({
      company: 'No Link Co',
      role: 'Data Intern',
      initialApplyUrl: null,
    });
  });

  it('stores apply-link states, keeps the source window authoritative, and expires malformed updates', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const firstReadme = `
| Company | Role | Posted | Link |
|---|---|---|---|
| Acme | Software Engineer Intern | 2026-09-05 | [Apply](https://jobs.example.com/acme/1?jobId=42) |
| No Link Co | Data Intern | 2026-08-21 | - |
| Old Co | QA Intern | 2026-08-20 | [Apply](https://jobs.example.com/old/1) |
`;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(firstReadme, { status: 200 }));

    const first = await syncGithubJobs({
      fetchImpl,
      now,
      readmeUrl: 'https://example.test/README.md',
    });

    expect(first.created).toBe(3);
    const acme = [...stored.values()].find((job) => job.company === 'Acme');
    const noLink = [...stored.values()].find((job) => job.company === 'No Link Co');
    const old = [...stored.values()].find((job) => job.company === 'Old Co');

    expect(acme).toMatchObject({
      applyUrl: 'https://jobs.example.com/acme/1?jobId=42',
      applyUrlStatus: 'verified',
      status: 'active',
    });
    expect(noLink).toMatchObject({ applyUrl: null, applyUrlStatus: 'pending', status: 'active' });
    expect(old).toMatchObject({ status: 'expired' });
    expect((acme?.expiresAt as Date).getTime()).toBe(now.getTime() + JOB_ACTIVE_WINDOW_MS);

    const malformedDateReadme = `
| Company | Role | Posted | Link |
|---|---|---|---|
| Acme | Software Engineer Intern | - | [Apply](https://jobs.example.com/acme/1?jobId=42) |
| No Link Co | Data Intern | 2026-09-05 | - |
`;
    fetchImpl.mockResolvedValueOnce(new Response(malformedDateReadme, { status: 200 }));

    const second = await syncGithubJobs({
      fetchImpl,
      now,
      readmeUrl: 'https://example.test/README.md',
    });

    // Acme lost its source date, and Old Co disappeared from the README.
    expect(second.expired).toBe(2);
    expect(acme?.status).toBe('expired');
    expect(noLink?.status).toBe('active');
  });

  it('does not expire the feed when the README no longer has a recognizable table', async () => {
    const now = new Date('2026-09-05T12:00:00.000Z');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(README, { status: 200 }))
      .mockResolvedValueOnce(new Response('# temporary upstream format change', { status: 200 }));

    await syncGithubJobs({ fetchImpl, now, readmeUrl: 'https://example.test/README.md' });
    const before = [...stored.values()].find((job) => job.company === 'Acme');

    const result = await syncGithubJobs({ fetchImpl, now, readmeUrl: 'https://example.test/README.md' });

    expect(result.expired).toBe(0);
    expect(before?.status).toBe('active');
  });
});
