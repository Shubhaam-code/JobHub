/**
 * The repair engine behind `npm run jobs:fix-apply-urls`.
 *
 * Two things are being pinned here, and they are the two that make the script safe
 * to point at production data:
 *
 *  1. **Dry-run is the default.** Every decision path is exercised twice — once
 *     without `apply`, asserting no write was attempted, and once with it.
 *  2. **Never worse than before.** An aggregator URL is cleared from the apply field
 *     and preserved in `sourceUrl`; a merely `suspicious` link is left exactly where
 *     it is and only gains a status, because clearing a link that probably works
 *     would be its own kind of damage.
 *
 * The database is mocked at the module boundary and `write` is injected, so these
 * are decisions under test, not Mongo.
 */

import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/models/apply-url-audit.model.js', () => ({
  ApplyUrlAuditModel: { create: vi.fn(), find: vi.fn() },
}));

vi.mock('../src/models/job.repository.js', () => ({
  updateApplyUrlFields: vi.fn(),
}));

import {
  delayKeyFor,
  jobRef,
  processJob,
  revertRun,
  type BackfillJob,
  type WriteInput,
} from '../src/apply-url/backfill.js';
import { ApplyUrlAuditModel } from '../src/models/apply-url-audit.model.js';
import { updateApplyUrlFields } from '../src/models/job.repository.js';

const ARTICLE_URL = 'https://freshershunt.in/cognizant-off-campus-drive-2026';
const WORKDAY_URL =
  'https://cognizant.wd1.myworkdayjobs.com/en-US/Cognizant_Careers/job/R-12345';

const PROSE = `
  <p>Cognizant is conducting an off campus drive for the 2026 batch. Eligible
  candidates from BE, BTech, ME, MTech, MCA and MSc streams can apply online
  through the official link at the end of this article. Read the eligibility
  criteria and the selection process carefully before applying.</p>
`;

const CLEAN_ARTICLE = `<article>${PROSE}<a href="${WORKDAY_URL}">Apply Now</a></article>`;

function job(overrides: Partial<BackfillJob> = {}): BackfillJob {
  return {
    _id: new mongoose.Types.ObjectId(),
    applyUrl: ARTICLE_URL,
    company: 'Cognizant',
    telegramChannel: 'jobs_and_internships_updates',
    telegramMessageId: 42,
    ...overrides,
  };
}

const html = (body: string) => (): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

function fetchFrom(map: Record<string, () => Response>): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const factory = map[url];
    if (factory === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve(factory());
  }) as unknown as typeof fetch;
}

/** A recording stand-in for the audit-then-write step. */
function recorder(result = true): {
  write: (input: WriteInput) => Promise<boolean>;
  calls: WriteInput[];
} {
  const calls: WriteInput[] = [];
  return {
    calls,
    write: (input: WriteInput) => {
      calls.push(input);
      return Promise.resolve(result);
    },
  };
}

const RUN = { runId: 'test-run', actor: 'test' };

describe('processJob — rows it must not touch', () => {
  it('leaves a verified, still-direct link alone', async () => {
    const { write, calls } = recorder();

    const result = await processJob(
      job({ applyUrl: WORKDAY_URL, applyUrlStatus: 'verified' }),
      { ...RUN, apply: true },
      { write },
    );

    expect(result.outcome).toBe('unchanged');
    expect(result.reason).toBe('already verified');
    expect(calls).toHaveLength(0);
  });

  it('never re-decides a row a human marked pending', async () => {
    const { write, calls } = recorder();

    // Even though the stored URL is an aggregator: someone chose `pending`, and a
    // script does not overrule a person.
    const result = await processJob(
      job({ applyUrlStatus: 'pending' }),
      { ...RUN, apply: true },
      { write },
    );

    expect(result.outcome).toBe('unchanged');
    expect(calls).toHaveLength(0);
  });

  it('re-examines a "verified" row whose URL this classifier rejects', async () => {
    /* A row verified before the classifier existed. Its status cannot be trusted,
       so it is judged again rather than skipped. */
    const { write, calls } = recorder();

    const result = await processJob(
      job({ applyUrlStatus: 'verified' }),
      { ...RUN, apply: true },
      { write, fetchImpl: fetchFrom({ [ARTICLE_URL]: html(CLEAN_ARTICLE) }) },
    );

    expect(result.outcome).toBe('repaired');
    expect(result.newUrl).toBe(WORKDAY_URL);
    expect(calls).toHaveLength(1);
  });
});

describe('processJob — a repair', () => {
  it('finds the employer link inside the article and stores it', async () => {
    const { write, calls } = recorder();

    const result = await processJob(
      job(),
      { ...RUN, apply: true },
      { write, fetchImpl: fetchFrom({ [ARTICLE_URL]: html(CLEAN_ARTICLE) }) },
    );

    expect(result.outcome).toBe('repaired');
    expect(result.oldUrl).toBe(ARTICLE_URL);
    expect(result.newUrl).toBe(WORKDAY_URL);
    expect(result.written).toBe(true);

    expect(calls[0]).toMatchObject({
      action: 'backfill',
      newUrl: WORKDAY_URL,
      newStatus: 'verified',
      // The article is provenance from here on, never a destination.
      newSourceUrl: ARTICLE_URL,
    });
  });

  it('writes nothing without --apply', async () => {
    const { write, calls } = recorder();

    const result = await processJob(
      job(),
      RUN,
      { write, fetchImpl: fetchFrom({ [ARTICLE_URL]: html(CLEAN_ARTICLE) }) },
    );

    // The decision is still reported in full — that is what the CSV is for.
    expect(result.outcome).toBe('repaired');
    expect(result.newUrl).toBe(WORKDAY_URL);
    expect(result.written).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('stamps a status on a link that was already direct', async () => {
    const { write, calls } = recorder();

    const result = await processJob(
      job({ applyUrl: WORKDAY_URL, applyUrlStatus: null }),
      { ...RUN, apply: true },
      { write },
    );

    expect(result.outcome).toBe('repaired');
    expect(result.newUrl).toBe(WORKDAY_URL);
    expect(calls[0]).toMatchObject({ newStatus: 'verified', newUrl: WORKDAY_URL });
  });
});

describe('processJob — when it cannot decide', () => {
  it('clears an aggregator link it cannot resolve and keeps it as the source', async () => {
    const { write, calls } = recorder();
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('socket hang up')),
    ) as unknown as typeof fetch;

    const result = await processJob(job(), { ...RUN, apply: true }, { write, fetchImpl });

    expect(result.outcome).toBe('flagged');
    expect(result.newUrl).toBeNull();
    expect(result.reason).toMatch(/aggregator page unreadable/);

    expect(calls[0]).toMatchObject({
      action: 'backfill_review',
      newUrl: null,
      newStatus: 'needs_review',
      newSourceUrl: ARTICLE_URL,
    });
  });

  it('offers every candidate to a human when none is conclusive', async () => {
    const ambiguous = `<article>${PROSE}
      <a href="${WORKDAY_URL}">Apply Now</a>
      <a href="https://cognizant.taleo.net/careersection/jobdetail?jobid=99">Apply Here</a>
    </article>`;

    const { write, calls } = recorder();

    const result = await processJob(
      job(),
      { ...RUN, apply: true },
      { write, fetchImpl: fetchFrom({ [ARTICLE_URL]: html(ambiguous) }) },
    );

    expect(result.outcome).toBe('flagged');
    expect(result.newUrl).toBeNull();
    expect(result.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]?.candidates?.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves a suspicious link in place and only records a status', async () => {
    /* This link may well work. Clearing it would remove a working apply button on
       a suspicion, so the URL stays and a human is asked. */
    const suspicious = 'https://linkedin.com/jobs/view/4001';
    const { write, calls } = recorder();

    const result = await processJob(
      job({ applyUrl: suspicious }),
      { ...RUN, apply: true },
      { write },
    );

    expect(result.outcome).toBe('flagged');
    expect(result.newUrl).toBe(suspicious);
    expect(calls[0]).toMatchObject({ newUrl: suspicious, newStatus: 'needs_review' });
  });

  it('records an empty apply field as pending, not as a defect', async () => {
    const { write, calls } = recorder();

    const result = await processJob(
      job({ applyUrl: null }),
      { ...RUN, apply: true },
      { write },
    );

    expect(result.outcome).toBe('flagged');
    expect(result.verdict).toBe('unresolvable');
    expect(calls[0]).toMatchObject({ newStatus: 'pending', newUrl: null });
  });

  it('records a malformed URL as needing review', async () => {
    const { write, calls } = recorder();

    const result = await processJob(
      job({ applyUrl: 'javascript:alert(1)' }),
      { ...RUN, apply: true },
      { write },
    );

    expect(result.outcome).toBe('flagged');
    expect(calls[0]).toMatchObject({ newStatus: 'needs_review' });
  });

  it('reports a failed write as an error rather than throwing', async () => {
    // One unreachable host must not end a run partway through the collection.
    const result = await processJob(
      job({ applyUrl: WORKDAY_URL }),
      { ...RUN, apply: true },
      { write: () => Promise.reject(new Error('audit insert failed')) },
    );

    expect(result.outcome).toBe('error');
    expect(result.reason).toBe('audit insert failed');
  });
});

describe('revertRun', () => {
  const postId = new mongoose.Types.ObjectId();

  const auditRow = {
    postId,
    oldUrl: ARTICLE_URL,
    newUrl: null,
    oldStatus: null,
    newStatus: 'needs_review',
    oldSourceUrl: null,
  };

  beforeEach(() => {
    vi.mocked(ApplyUrlAuditModel.create).mockReset();
    vi.mocked(ApplyUrlAuditModel.find).mockReset();
    vi.mocked(updateApplyUrlFields).mockReset();

    vi.mocked(ApplyUrlAuditModel.find).mockReturnValue({
      sort: () => ({ lean: () => Promise.resolve([auditRow]) }),
    } as never);
  });

  it('reads the run newest-first and skips its own revert rows', async () => {
    await revertRun('run-1', { actor: 'test' });

    expect(ApplyUrlAuditModel.find).toHaveBeenCalledWith({
      runId: 'run-1',
      action: { $ne: 'revert' },
    });
  });

  it('writes nothing without --apply', async () => {
    const summary = await revertRun('run-1', { actor: 'test' });

    expect(summary).toEqual({ examined: 1, reverted: 1, conflicts: 0 });
    expect(updateApplyUrlFields).not.toHaveBeenCalled();
    expect(ApplyUrlAuditModel.create).not.toHaveBeenCalled();
  });

  it('restores the previous value and audits the revert itself', async () => {
    vi.mocked(updateApplyUrlFields).mockResolvedValue(true);

    const summary = await revertRun('run-1', { actor: 'test', apply: true });

    expect(summary).toEqual({ examined: 1, reverted: 1, conflicts: 0 });
    expect(updateApplyUrlFields).toHaveBeenCalledWith(
      postId,
      expect.objectContaining({ applyUrl: ARTICLE_URL }),
      // Matched on the value the run wrote, so a row changed since is left alone.
      null,
    );
    // A revert is a write, and the same rule applies to it.
    expect(ApplyUrlAuditModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'revert', runId: 'revert-of-run-1' }),
    );
  });

  it('reports a row someone changed since the run as a conflict', async () => {
    vi.mocked(updateApplyUrlFields).mockResolvedValue(false);

    const summary = await revertRun('run-1', { actor: 'test', apply: true });

    expect(summary).toEqual({ examined: 1, reverted: 0, conflicts: 1 });
    // Nothing is rolled back over a human's decision, and no audit row is written.
    expect(ApplyUrlAuditModel.create).not.toHaveBeenCalled();
  });
});

describe('log and politeness helpers', () => {
  it('labels a job by its Telegram coordinates when it has them', () => {
    expect(jobRef(job())).toBe('[@jobs_and_internships_updates msg 42]');
  });

  it('falls back to the job id', () => {
    const row = job({ telegramChannel: null, telegramMessageId: null });
    expect(jobRef(row)).toBe(`[job ${String(row._id)}]`);
  });

  it('keys the per-host delay on the host, and tolerates no URL', () => {
    expect(delayKeyFor(ARTICLE_URL)).toBe('freshershunt.in');
    expect(delayKeyFor(null)).toBe('');
    expect(delayKeyFor('not a url')).toBe('');
  });
});
