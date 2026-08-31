import type { Error as MongooseError } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { JobModel, type Job, type JobDocument } from '../src/models/job.model.js';

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
