/**
 * `enqueueDiscoveryJob` — one discovery row per job, whatever the caller does.
 *
 * The bug these guard against cost real money: the live `{ jobId: 1 }` index was
 * built without `unique: true`, Mongo would not rebuild it from the schema, and the
 * old implementation's `create()`-then-catch-duplicate-key strategy depended
 * entirely on that index throwing. With no throw, 107 jobs accumulated 289 rows and
 * each surplus row paid for its own Firecrawl scrape and web search.
 *
 * So the model is mocked at the boundary rather than run against a database: what
 * matters is which Mongo operation is issued. An upsert keyed on `jobId` is correct
 * with or without the index; a create is not. That distinction is invisible to a
 * test that only checks the returned outcome.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/models/apply-discovery-queue.model.js', () => ({
  ApplyDiscoveryQueueModel: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
  },
  DISCOVERY_STATUSES: [
    'pending',
    'processing',
    'completed',
    'not_found',
    'retry_wait',
    'failed',
  ] as const,
}));

const { ApplyDiscoveryQueueModel } = await import('../src/models/apply-discovery-queue.model.js');
const { enqueueDiscoveryJob } = await import('../src/apply-discovery/queue.js');

const model = ApplyDiscoveryQueueModel as unknown as {
  findOne: ReturnType<typeof vi.fn>;
  findOneAndUpdate: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};

const JOB_ID = '64f1a2b3c4d5e6f7a8b9c001';

const input = {
  jobId: JOB_ID,
  company: 'Infosys',
  role: 'Systems Engineer',
  location: 'Bengaluru',
  employmentType: 'full-time',
  batch: '2026',
  sourceUrl: 'https://example.com/post',
  initialApplyUrl: null,
  initialCandidates: null,
};

/** `findOne(...).select(...).lean()` — the existing-row lookup. */
function stubExistingRow(row: Record<string, unknown> | null): void {
  model.findOne.mockReturnValue({
    select: () => ({ lean: async () => row }),
  });
}

/** `findOneAndUpdate(...).exec()` with `includeResultMetadata: true`. */
function stubUpsert(updatedExisting: boolean, id = 'discovery-1'): void {
  model.findOneAndUpdate.mockReturnValue({
    exec: async () => ({
      value: { _id: id },
      lastErrorObject: { updatedExisting },
    }),
  });
}

beforeEach(() => {
  model.findOne.mockReset();
  model.findOneAndUpdate.mockReset();
  model.create.mockReset();
});

describe('enqueueDiscoveryJob — duplicate-safe by construction', () => {
  it('creates the first row through an upsert, not an insert', async () => {
    stubExistingRow(null);
    stubUpsert(false, 'discovery-new');

    const result = await enqueueDiscoveryJob(input);

    expect(result).toEqual({ outcome: 'queued', discoveryJobId: 'discovery-new' });

    /* The heart of the fix. `create()` inserts unconditionally, so on a database
       whose jobId index is not unique it produces a second row for the same job. */
    expect(model.create).not.toHaveBeenCalled();

    const [filter, , options] = model.findOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      unknown,
      Record<string, unknown>,
    ];
    expect(filter).toEqual({ jobId: JOB_ID });
    expect(options.upsert).toBe(true);
  });

  it('reuses the existing row on a second enqueue instead of adding one', async () => {
    stubExistingRow({ _id: 'discovery-1', status: 'not_found', verified: false });
    stubUpsert(true, 'discovery-1');

    const result = await enqueueDiscoveryJob(input);

    expect(result).toEqual({ outcome: 'updated', discoveryJobId: 'discovery-1' });
    expect(model.create).not.toHaveBeenCalled();
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('resets a spent row to pending so a re-run can escalate', async () => {
    stubExistingRow({ _id: 'discovery-1', status: 'failed', verified: false });
    stubUpsert(true);

    await enqueueDiscoveryJob(input);

    const [, update] = model.findOneAndUpdate.mock.calls[0] as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set.status).toBe('pending');
    expect(update.$set.attempts).toBe(0);
    expect(update.$set.nextRetryAt).toBeNull();
    expect(update.$set.claimedAt).toBeNull();
  });

  /* ── Rows that must be left alone ──────────────────────────────────────────
     Both of these would otherwise be re-billed: a verified job already has its
     answer, and a claimed row is being paid for right now by a worker. */

  it('refuses to touch an already verified job', async () => {
    stubExistingRow({ _id: 'discovery-1', status: 'completed', verified: true });

    const result = await enqueueDiscoveryJob(input);

    expect(result).toEqual({ outcome: 'duplicate', discoveryJobId: 'discovery-1' });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('leaves an in-flight claim to the worker that holds it', async () => {
    stubExistingRow({ _id: 'discovery-1', status: 'processing', verified: false });

    const result = await enqueueDiscoveryJob(input);

    expect(result).toEqual({ outcome: 'duplicate', discoveryJobId: 'discovery-1' });
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('re-queues a completed row that never verified', async () => {
    stubExistingRow({ _id: 'discovery-1', status: 'completed', verified: false });
    stubUpsert(true);

    const result = await enqueueDiscoveryJob(input);

    expect(result.outcome).toBe('updated');
  });

  /* ── The race ─────────────────────────────────────────────────────────────
     Two enqueues for one new job both read "no row" and both upsert. The unique
     index rejects the loser; the winner's row is the single row the job gets, so
     the loser reports duplicate rather than resetting what the winner queued. */

  it('yields to the winner when two enqueues race', async () => {
    stubExistingRow(null);
    model.findOneAndUpdate.mockReturnValue({
      exec: async () => {
        throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      },
    });

    /* Second lookup: the winner's row now exists. */
    model.findOne
      .mockReturnValueOnce({ select: () => ({ lean: async () => null }) })
      .mockReturnValueOnce({ select: () => ({ lean: async () => ({ _id: 'winner' }) }) });

    const result = await enqueueDiscoveryJob(input);

    expect(result).toEqual({ outcome: 'duplicate', discoveryJobId: 'winner' });
  });

  it('propagates a non-duplicate write error instead of swallowing it', async () => {
    stubExistingRow(null);
    model.findOneAndUpdate.mockReturnValue({
      exec: async () => {
        throw new Error('connection reset');
      },
    });

    await expect(enqueueDiscoveryJob(input)).rejects.toThrow('connection reset');
  });
});
