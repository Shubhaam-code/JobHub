/**
 * The single write path for a job's apply fields.
 *
 * `resolveApplyUrlFields` is the function that turns a classifier verdict into the
 * four stored fields, and every caller — the queue worker, the repair script, the
 * admin queue — goes through it. So the table below is the whole contract:
 *
 *   direct       → stored, `verified`
 *   aggregator   → apply field empty, URL moved to `sourceUrl`, `needs_review`
 *   wrapper      → apply field empty, kept as a candidate, `needs_review`
 *   suspicious   → apply field empty, kept as a candidate, `needs_review`
 *   unresolvable → apply field empty, `pending` when there was no URL at all
 *
 * Note what does *not* happen for an aggregator: the URL is neither deleted (it is
 * real provenance and the only lead a human has) nor left in the apply field (it is
 * a competitor's article). Moving it to `sourceUrl` is what satisfies both.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/models/job.model.js', () => ({
  JobModel: { updateOne: vi.fn(), create: vi.fn() },
}));

import { JobModel } from '../src/models/job.model.js';
import {
  resolveApplyUrlFields,
  updateApplyUrlFields,
} from '../src/models/job.repository.js';

const WORKDAY_URL =
  'https://cognizant.wd1.myworkdayjobs.com/en-US/Cognizant_Careers/job/R-12345';
const ARTICLE_URL = 'https://freshershunt.in/cognizant-off-campus-drive-2026';

describe('resolveApplyUrlFields', () => {
  it('stores a direct link and marks it verified', () => {
    const fields = resolveApplyUrlFields(WORKDAY_URL, { company: 'Cognizant' });

    expect(fields).toMatchObject({
      applyUrl: WORKDAY_URL,
      applyUrlStatus: 'verified',
      applyUrlCandidates: null,
      sourceUrl: null,
    });
  });

  it('normalizes on the way in, so one link has one stored spelling', () => {
    const fields = resolveApplyUrlFields(
      'HTTP://WWW.Cognizant.wd1.myworkdayjobs.com/en-US/Cognizant_Careers/job/R-12345?utm_source=telegram',
    );

    expect(fields.applyUrl).toBe(WORKDAY_URL);
  });

  it('moves an aggregator article to sourceUrl and leaves the apply field empty', () => {
    const fields = resolveApplyUrlFields(ARTICLE_URL, { company: 'Cognizant' });

    expect(fields.applyUrl).toBeNull();
    expect(fields.sourceUrl).toBe(ARTICLE_URL);
    expect(fields.applyUrlStatus).toBe('needs_review');
  });

  it('keeps an unresolved shortener as a candidate rather than storing it', () => {
    const fields = resolveApplyUrlFields('https://bit.ly/3xYzAbc');

    expect(fields.applyUrl).toBeNull();
    expect(fields.applyUrlStatus).toBe('needs_review');
    expect(fields.applyUrlCandidates).toEqual([
      expect.objectContaining({ url: 'https://bit.ly/3xYzAbc', confidence: 'low' }),
    ]);
  });

  it('keeps a suspicious link as a candidate', () => {
    const fields = resolveApplyUrlFields('https://linkedin.com/jobs/view/4001');

    expect(fields.applyUrl).toBeNull();
    expect(fields.applyUrlCandidates?.[0]?.url).toBe('https://linkedin.com/jobs/view/4001');
  });

  it('calls an absent link pending, not broken', () => {
    // Registration simply may not be open yet. An empty apply field is correct.
    const fields = resolveApplyUrlFields(null);

    expect(fields.applyUrl).toBeNull();
    expect(fields.applyUrlStatus).toBe('pending');
    expect(fields.applyUrlCandidates).toBeNull();
  });

  it('calls a malformed link a defect a human should see', () => {
    const fields = resolveApplyUrlFields('javascript:alert(1)');

    expect(fields.applyUrl).toBeNull();
    expect(fields.applyUrlStatus).toBe('needs_review');
  });

  it('keeps a caller-supplied sourceUrl when the link itself is direct', () => {
    const fields = resolveApplyUrlFields(WORKDAY_URL, {
      company: 'Cognizant',
      sourceUrl: ARTICLE_URL,
    });

    expect(fields.applyUrl).toBe(WORKDAY_URL);
    expect(fields.sourceUrl).toBe(ARTICLE_URL);
  });

  it('carries the classification through for the log line', () => {
    const fields = resolveApplyUrlFields(ARTICLE_URL);

    expect(fields.classification.verdict).toBe('aggregator');
    expect(fields.classification.reason).toMatch(/known job-aggregator domain/);
    expect(fields.applyUrlCheckedAt).toBeInstanceOf(Date);
  });
});

describe('updateApplyUrlFields', () => {
  it('refuses to write an aggregator URL into the apply field', async () => {
    /* `$set` bypasses the schema validator, so this is where that guard lives for
       the update path — and it throws before anything reaches the database. */
    vi.mocked(JobModel.updateOne).mockClear();

    await expect(
      updateApplyUrlFields('id', { applyUrl: ARTICLE_URL }),
    ).rejects.toThrow(/refusing to store an aggregator URL/);

    expect(JobModel.updateOne).not.toHaveBeenCalled();
  });

  it('matches the expected current value, so a stale read cannot overwrite', async () => {
    vi.mocked(JobModel.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

    const updated = await updateApplyUrlFields(
      'id',
      { applyUrl: WORKDAY_URL, applyUrlStatus: 'verified' },
      ARTICLE_URL,
    );

    expect(updated).toBe(true);
    expect(JobModel.updateOne).toHaveBeenCalledWith(
      { _id: 'id', applyUrl: ARTICLE_URL },
      { $set: { applyUrl: WORKDAY_URL, applyUrlStatus: 'verified' } },
    );
  });

  it('reports a row that changed under it as not modified', async () => {
    vi.mocked(JobModel.updateOne).mockResolvedValue({ modifiedCount: 0 } as never);

    expect(await updateApplyUrlFields('id', { applyUrlStatus: 'broken' }, WORKDAY_URL)).toBe(
      false,
    );
  });

  it('omits the guard from the filter when no expected value is given', async () => {
    vi.mocked(JobModel.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

    await updateApplyUrlFields('id', { applyUrlStatus: 'pending' });

    expect(JobModel.updateOne).toHaveBeenCalledWith(
      { _id: 'id' },
      { $set: { applyUrlStatus: 'pending' } },
    );
  });

  it('allows clearing the apply field', async () => {
    // Clearing is how an aggregator link is removed, so null must pass the guard.
    vi.mocked(JobModel.updateOne).mockResolvedValue({ modifiedCount: 1 } as never);

    expect(await updateApplyUrlFields('id', { applyUrl: null })).toBe(true);
  });
});
