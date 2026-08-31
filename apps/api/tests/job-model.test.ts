import mongoose, { type Error as MongooseError } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JOB_ACTIVE_WINDOW_MS,
  jobExpiryFrom,
  JobModel,
  type Job,
  type JobDocument,
} from '../src/models/job.model.js';

const validJob: Partial<Job> = {
  company: 'Example Corp',
  role: 'Backend Intern',
  batch: '2027',
  applyUrl: 'https://example.test/apply',
  source: 'telegram',
  telegramChannel: 'jobs_and_internships_updates',
  telegramMessageId: 42,
  telegramMessageUrl: 'https://t.me/jobs_and_internships_updates/42',
  originalText: 'Company: Example Corp\nRole: Backend Intern',
  postedAt: new Date('2026-08-01T12:00:00Z'),
};

/** Runs validation and returns the error, failing the test if it unexpectedly passes. */
async function captureValidationError(doc: JobDocument): Promise<MongooseError.ValidationError> {
  try {
    await doc.validate();
  } catch (error) {
    return error as MongooseError.ValidationError;
  }

  throw new Error('Expected validation to fail, but it succeeded.');
}

/**
 * Runs the save middleware — mongoose's own timestamps hook and then the expiry
 * hook — without a database.
 *
 * With command buffering off, `save()` rejects the moment it reaches the driver,
 * which is after every `pre('save')` hook has already run against the document.
 * The rejection is the expected outcome here, not a failure: what it leaves
 * behind is a document stamped exactly as a real save would have stamped it,
 * which is what makes the createdAt → expiresAt tie assertable offline.
 */
async function runSaveHooks(doc: JobDocument): Promise<void> {
  await doc.save().catch(() => undefined);
}

describe('Job model (Telegram ingestion schema)', () => {
  it('validates a well-formed job document without a database connection', async () => {
    const job = new JobModel(validJob);

    await expect(job.validate()).resolves.toBeUndefined();
    expect(job.company).toBe('Example Corp');
    expect(job.role).toBe('Backend Intern');
    expect(job.batch).toBe('2027');
    expect(job.applyUrl).toBe('https://example.test/apply');
    expect(job.source).toBe('telegram');
    expect(job.telegramChannel).toBe('jobs_and_internships_updates');
    expect(job.telegramMessageId).toBe(42);
  });

  it('allows nullable extracted fields to default to null', async () => {
    const job = new JobModel({
      ...validJob,
      company: undefined,
      role: undefined,
      batch: undefined,
      applyUrl: undefined,
      telegramMessageUrl: undefined,
    });

    await expect(job.validate()).resolves.toBeUndefined();
    expect(job.company).toBeNull();
    expect(job.role).toBeNull();
    expect(job.batch).toBeNull();
    expect(job.applyUrl).toBeNull();
    expect(job.telegramMessageUrl).toBeNull();
  });

  it('requires provenance fields', async () => {
    const error = await captureValidationError(new JobModel({} as Partial<Job>));

    const missing = Object.keys(error.errors).sort();
    expect(missing).toContain('source');
    expect(missing).toContain('telegramChannel');
    expect(missing).toContain('telegramMessageId');
    expect(missing).toContain('originalText');
    expect(missing).toContain('postedAt');
  });
});

describe('Job lifecycle (21-day expiry)', () => {
  beforeAll(() => {
    mongoose.set('bufferCommands', false);
  });

  afterAll(() => {
    mongoose.set('bufferCommands', true);
  });

  it('starts a new listing active', () => {
    expect(new JobModel(validJob).status).toBe('active');
  });

  it('leaves expiresAt unset until save, so nothing pre-empts a source deadline', () => {
    expect(new JobModel(validJob).expiresAt).toBeNull();
  });

  it('expires a saved listing exactly 21 days after its own createdAt', async () => {
    const job = new JobModel(validJob);

    await runSaveHooks(job);

    const createdAt = job.get('createdAt') as Date | undefined;
    expect(createdAt).toBeInstanceOf(Date);
    expect(job.expiresAt).toBeInstanceOf(Date);
    expect(job.expiresAt?.getTime()).toBe((createdAt as Date).getTime() + JOB_ACTIVE_WINDOW_MS);
    expect(job.expiresAt).toEqual(jobExpiryFrom(createdAt as Date));
  });

  it('keeps a deadline the source published rather than overwriting it', async () => {
    const sourceDeadline = new Date('2026-09-05T00:00:00.000Z');
    const job = new JobModel({ ...validJob, expiresAt: sourceDeadline });

    await runSaveHooks(job);

    expect(job.expiresAt).toEqual(sourceDeadline);
  });

  it('accepts only known lifecycle statuses', async () => {
    const job = new JobModel(validJob);
    // Set through `set` rather than the constructor: an out-of-enum value cannot
    // be written in the model's own types, and the guard is there for stored
    // data anyway, not for callers TypeScript can already see.
    job.set('status', 'archived');

    const error = await captureValidationError(job);

    expect(Object.keys(error.errors)).toContain('status');
  });
});
