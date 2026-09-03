import { describe, expect, it, vi } from 'vitest';

import { JobModel } from '../src/models/job.model.js';
import {
  runCompanyLogoBackfill,
  type CompanyLogoBackfillSummary,
  type StoredJobLogo,
} from '../src/telegram/company-logo-backfill.js';
import type { CompanyLogoResolution } from '../src/telegram/company-logo.js';

const LOGO = 'https://icons.duckduckgo.com/ip3/zoho.com.ico';
const EXISTING_LOGO = 'https://icons.duckduckgo.com/ip3/infosys.com.ico';

let nextId = 1;

function job(
  company: string | null,
  overrides: Partial<StoredJobLogo> = {},
): StoredJobLogo {
  return {
    _id: `id-${nextId++}`,
    company,
    companyLogoUrl: null,
    telegramChannel: 'offcampusjobs4u',
    telegramMessageId: 4821,
    ...overrides,
  };
}

/** A resolver stub plus the companies it was asked about. */
function createResolver(
  outcome: (company: string) => CompanyLogoResolution = () => ({
    url: LOGO,
    source: 'network',
  }),
) {
  const seen: string[] = [];

  const resolve = vi.fn(async (company: string): Promise<CompanyLogoResolution> => {
    seen.push(company);
    return outcome(company);
  });

  return { resolve, seen };
}

/** Records every write the run performed, as (id, companyLogoUrl) pairs. */
function createWriter() {
  const writes: Array<{ id: unknown; companyLogoUrl: string }> = [];

  const saveLogoUrl = vi.fn(
    async (target: StoredJobLogo, companyLogoUrl: string): Promise<void> => {
      writes.push({ id: target._id, companyLogoUrl });
    },
  );

  return { saveLogoUrl, writes };
}

function run(
  jobs: StoredJobLogo[],
  options: Partial<Parameters<typeof runCompanyLogoBackfill>[0]> = {},
): Promise<CompanyLogoBackfillSummary> {
  return runCompanyLogoBackfill({ jobs, ...options });
}

describe('runCompanyLogoBackfill — selection', () => {
  it('fills in a missing logo from the company name', async () => {
    const { resolve, seen } = createResolver();
    const { saveLogoUrl, writes } = createWriter();
    const target = job('Zoho');

    const summary = await run([target], { resolve, saveLogoUrl });

    expect(seen).toEqual(['Zoho']);
    expect(writes).toEqual([{ id: target._id, companyLogoUrl: LOGO }]);
    expect(summary).toMatchObject({
      examined: 1,
      candidates: 1,
      updated: 1,
      skippedHasLogo: 0,
      skippedNoCompany: 0,
      notFound: 0,
      errors: 0,
      dryRun: false,
    });
  });

  it('never overwrites a job that already has a logo, and makes no request for it', async () => {
    const { resolve } = createResolver();
    const { saveLogoUrl } = createWriter();

    const summary = await run([job('Infosys', { companyLogoUrl: EXISTING_LOGO })], {
      resolve,
      saveLogoUrl,
    });

    expect(resolve).not.toHaveBeenCalled();
    expect(saveLogoUrl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ examined: 1, candidates: 0, skippedHasLogo: 1, updated: 0 });
  });

  it('skips a job with no company name without a request', async () => {
    const { resolve } = createResolver();
    const { saveLogoUrl } = createWriter();

    const summary = await run([job(null), job(''), job('   ')], { resolve, saveLogoUrl });

    expect(resolve).not.toHaveBeenCalled();
    expect(saveLogoUrl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ examined: 3, candidates: 0, skippedNoCompany: 3 });
  });

  it('skips a placeholder company name without a request', async () => {
    const { resolve } = createResolver();

    const summary = await run(
      ['Confidential', 'MNC', 'Various', 'Not Specified'].map((name) => job(name)),
      { resolve },
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ examined: 4, candidates: 0, skippedNoCompany: 4 });
  });

  it('picks the right rows out of a mixed collection', async () => {
    const { resolve, seen } = createResolver();
    const { saveLogoUrl, writes } = createWriter();

    const rows = [
      job('Infosys', { companyLogoUrl: EXISTING_LOGO }),
      job('Zoho'),
      job(null),
      job('Confidential'),
      job('Wipro'),
    ];

    const summary = await run(rows, { resolve, saveLogoUrl });

    expect(seen).toEqual(['Zoho', 'Wipro']);
    expect(summary).toMatchObject({
      examined: 5,
      candidates: 2,
      skippedHasLogo: 1,
      skippedNoCompany: 2,
      updated: 2,
    });
    expect(writes.map((entry) => entry.id)).toEqual([rows[1]?._id, rows[4]?._id]);
  });
});

describe('runCompanyLogoBackfill — dry run writes nothing', () => {
  it('reports the change it would make but performs no write', async () => {
    const { resolve } = createResolver();
    const { saveLogoUrl } = createWriter();

    const summary = await run([job('Zoho')], { resolve, saveLogoUrl, dryRun: true });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(saveLogoUrl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 1, updated: 1, dryRun: true });
  });

  it('a dry run and a real run over the same rows report the same counts', async () => {
    const rows = [
      job('Zoho'),
      job('Infosys', { companyLogoUrl: EXISTING_LOGO }),
      job('Confidential'),
      job('Wipro'),
    ];

    const dry = await run(rows, { resolve: createResolver().resolve, dryRun: true });
    const wet = await run(rows, {
      resolve: createResolver().resolve,
      saveLogoUrl: createWriter().saveLogoUrl,
    });

    expect(dry.updated).toBe(wet.updated);
    expect(dry.candidates).toBe(wet.candidates);
    expect(dry.skippedHasLogo).toBe(wet.skippedHasLogo);
    expect(dry.skippedNoCompany).toBe(wet.skippedNoCompany);
    expect(dry.companiesResolved).toBe(wet.companiesResolved);
  });
});

describe('runCompanyLogoBackfill — a company with no logo is left alone', () => {
  it('leaves the row unchanged when nothing was found', async () => {
    const { resolve } = createResolver(() => ({
      url: null,
      source: 'network',
      reason: 'no logo found for acme.com, acme.in, acme.co.in',
    }));
    const { saveLogoUrl } = createWriter();

    const summary = await run([job('Acme')], { resolve, saveLogoUrl });

    expect(saveLogoUrl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 1, updated: 0, notFound: 1, errors: 0 });
  });

  it('counts a resolver throw as an error and keeps going', async () => {
    const resolve = vi
      .fn<(company: string) => Promise<CompanyLogoResolution>>()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ url: LOGO, source: 'network' });
    const { saveLogoUrl, writes } = createWriter();

    const summary = await run([job('Acme'), job('Zoho')], { resolve, saveLogoUrl });

    expect(summary).toMatchObject({ candidates: 2, updated: 1, errors: 1 });
    expect(writes).toHaveLength(1);
  });

  it('counts a failed write as an error rather than as an update', async () => {
    const { resolve } = createResolver();
    const saveLogoUrl = vi
      .fn<(job: StoredJobLogo, companyLogoUrl: string) => Promise<void>>()
      .mockRejectedValue(new Error('connection lost'));

    const summary = await run([job('Zoho')], { resolve, saveLogoUrl });

    expect(summary).toMatchObject({ candidates: 1, updated: 0, errors: 1 });
  });

  it('one failing row does not stop the rest of the run', async () => {
    const { resolve } = createResolver();
    const saveLogoUrl = vi
      .fn<(job: StoredJobLogo, companyLogoUrl: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(undefined);

    const summary = await run([job('Zoho'), job('Wipro'), job('Infosys')], {
      resolve,
      saveLogoUrl,
    });

    expect(summary).toMatchObject({ candidates: 3, updated: 2, errors: 1 });
  });
});

describe('runCompanyLogoBackfill — idempotence', () => {
  it('a second run over already-populated rows resolves and writes nothing', async () => {
    const target = job('Zoho');

    await run([target], {
      resolve: createResolver().resolve,
      saveLogoUrl: createWriter().saveLogoUrl,
    });

    // What the database now holds.
    const populated = { ...target, companyLogoUrl: LOGO };
    const second = createResolver();
    const { saveLogoUrl } = createWriter();

    const summary = await run([populated], { resolve: second.resolve, saveLogoUrl });

    expect(second.resolve).not.toHaveBeenCalled();
    expect(saveLogoUrl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({
      examined: 1,
      candidates: 0,
      skippedHasLogo: 1,
      updated: 0,
    });
  });
});

describe('runCompanyLogoBackfill — one lookup per company', () => {
  it('resolves a repeated company once and writes every one of its jobs', async () => {
    const { resolve, seen } = createResolver();
    const { saveLogoUrl, writes } = createWriter();

    const rows = [job('Zoho'), job('Zoho Corporation'), job('  zoho  '), job('Zoho Pvt Ltd')];

    const summary = await run(rows, { resolve, saveLogoUrl });

    expect(seen).toEqual(['Zoho']);
    expect(summary).toMatchObject({ candidates: 4, updated: 4, companiesResolved: 1 });
    expect(writes).toHaveLength(4);
  });

  it('remembers a miss for the rest of the run', async () => {
    const { resolve } = createResolver(() => ({ url: null, source: 'network' }));
    const { saveLogoUrl } = createWriter();

    const summary = await run([job('Acme'), job('Acme Ltd'), job('Acme')], {
      resolve,
      saveLogoUrl,
    });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(saveLogoUrl).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 3, notFound: 3, updated: 0, companiesResolved: 1 });
  });

  it('pauses once per lookup, not once per row', async () => {
    const { resolve } = createResolver();
    const rows = [job('Zoho'), job('Zoho'), job('Zoho')];

    const started = Date.now();
    const summary = await run(rows, { resolve, saveLogoUrl: createWriter().saveLogoUrl, pauseMs: 40 });
    const elapsed = Date.now() - started;

    expect(summary.companiesResolved).toBe(1);
    // One pause of 40ms, not three. Generous bound so a slow CI box still passes.
    expect(elapsed).toBeLessThan(120);
  });
});

describe('runCompanyLogoBackfill — bounds and streaming', () => {
  it('stops after the candidate limit, leaving later rows untouched', async () => {
    const { resolve } = createResolver();
    const { saveLogoUrl, writes } = createWriter();

    const rows = [job('Zoho'), job('Wipro'), job('Infosys')];

    const summary = await run(rows, { resolve, saveLogoUrl, limit: 2 });

    expect(summary).toMatchObject({ candidates: 2, updated: 2 });
    expect(writes.map((entry) => entry.id)).toEqual([rows[0]?._id, rows[1]?._id]);
  });

  it('consumes an async iterable lazily, as a Mongo cursor would', async () => {
    const yielded: string[] = [];

    async function* cursor(): AsyncGenerator<StoredJobLogo> {
      for (const name of ['Zoho', 'Confidential', 'Wipro']) {
        yielded.push(name);
        yield job(name);
      }
    }

    const summary = await runCompanyLogoBackfill({
      jobs: cursor(),
      resolve: createResolver().resolve,
      saveLogoUrl: createWriter().saveLogoUrl,
    });

    expect(yielded).toHaveLength(3);
    expect(summary).toMatchObject({ examined: 3, candidates: 2, updated: 2 });
  });

  it('reports all-zero counts for an empty collection', async () => {
    const summary = await run([]);

    expect(summary).toMatchObject({
      examined: 0,
      candidates: 0,
      updated: 0,
      skippedHasLogo: 0,
      skippedNoCompany: 0,
      notFound: 0,
      errors: 0,
      companiesResolved: 0,
    });
  });
});

/**
 * The tests above drive the injected `saveLogoUrl` hook. These drive the real
 * default one, so the update document that actually reaches MongoDB is asserted
 * rather than assumed — that document is the whole of the "nothing but
 * companyLogoUrl is written" guarantee.
 */
describe('runCompanyLogoBackfill — the update sent to MongoDB', () => {
  /** Spies on the real write. `restoreMocks` in vitest.config.ts undoes it. */
  function spyOnUpdate() {
    return vi
      .spyOn(JobModel, 'updateOne')
      .mockReturnValue({ acknowledged: true, modifiedCount: 1 } as unknown as ReturnType<
        typeof JobModel.updateOne
      >);
  }

  it('sets companyLogoUrl and nothing else', async () => {
    const updateOne = spyOnUpdate();
    const target = job('Zoho');

    // No saveLogoUrl override: this exercises saveLogoUrlToDatabase itself.
    await run([target], { resolve: createResolver().resolve });

    expect(updateOne).toHaveBeenCalledTimes(1);

    const [filter, update] = updateOne.mock.calls[0] ?? [];

    expect(update).toEqual({ $set: { companyLogoUrl: LOGO } });

    // The filter pins the row by id *and* by the logo still being absent, so a
    // job the queue worker populated in between is skipped, not clobbered.
    expect(filter).toEqual({ _id: target._id, companyLogoUrl: { $in: [null, ''] } });
  });

  it('never leaves another field in the update, so nothing else can shift', async () => {
    const updateOne = spyOnUpdate();

    await run([job('Zoho')], { resolve: createResolver().resolve });

    const update = updateOne.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    const set = (update?.$set ?? {}) as Record<string, unknown>;

    expect(Object.keys(set)).toEqual(['companyLogoUrl']);

    for (const field of [
      'company',
      'role',
      'batch',
      'applyUrl',
      'location',
      'employmentType',
      'source',
      'telegramChannel',
      'telegramChannelId',
      'telegramMessageId',
      'telegramMessageUrl',
      'originalText',
      'cleanedText',
      'postedAt',
      'status',
      'expiresAt',
    ]) {
      expect(set).not.toHaveProperty(field);
    }

    // `updateOne` also bypasses the model's pre('save') hook, which is what keeps
    // a backfill from re-stamping expiresAt as a side effect.
    expect(Object.keys(update ?? {})).toEqual(['$set']);
  });

  it('issues no update at all in dry-run mode', async () => {
    const updateOne = spyOnUpdate();

    const summary = await run([job('Zoho')], {
      resolve: createResolver().resolve,
      dryRun: true,
    });

    expect(updateOne).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ candidates: 1, updated: 1, dryRun: true });
  });

  it('issues no update for a row that already has a logo', async () => {
    const updateOne = spyOnUpdate();

    await run([job('Infosys', { companyLogoUrl: EXISTING_LOGO })], {
      resolve: createResolver().resolve,
    });

    expect(updateOne).not.toHaveBeenCalled();
  });

  it('issues no update when nothing was found for the company', async () => {
    const updateOne = spyOnUpdate();

    await run([job('Acme')], {
      resolve: createResolver(() => ({ url: null, source: 'network' })).resolve,
    });

    expect(updateOne).not.toHaveBeenCalled();
  });
});
