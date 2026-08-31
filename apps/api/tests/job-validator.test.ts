import { describe, expect, it } from 'vitest';

import { validateClassifiedJob } from '../src/telegram/job-validator.js';
import type { ClassifiedJob } from '../src/telegram/job-classifier.js';

function job(overrides: Partial<ClassifiedJob> = {}): ClassifiedJob {
  return {
    isJob: true,
    company: 'Amazon',
    role: 'Software Engineering Intern',
    batch: '2027',
    applyUrl: 'https://amazon.jobs/en/jobs/123',
    location: 'Bengaluru',
    employmentType: 'internship',
    ...overrides,
  };
}

describe('validateClassifiedJob', () => {
  it('accepts a complete job', () => {
    expect(validateClassifiedJob(job())).toEqual({ valid: true });
  });

  it('rejects anything the classifier marked as not a job', () => {
    expect(validateClassifiedJob(job({ isJob: false }))).toEqual({
      valid: false,
      reason: 'not a job',
    });
  });

  it('accepts a job with only a company', () => {
    expect(validateClassifiedJob(job({ role: null })).valid).toBe(true);
  });

  it('accepts a job with only a role', () => {
    expect(validateClassifiedJob(job({ company: null })).valid).toBe(true);
  });

  it('rejects a job with neither company nor role', () => {
    expect(validateClassifiedJob(job({ company: null, role: null }))).toEqual({
      valid: false,
      reason: 'neither company nor role could be extracted',
    });
  });

  it('accepts missing batch, applyUrl, location and employmentType', () => {
    const result = validateClassifiedJob(
      job({ batch: null, applyUrl: null, location: null, employmentType: null }),
    );

    expect(result).toEqual({ valid: true });
  });

  it('rejects an unsafe applyUrl scheme', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const result = validateClassifiedJob(job({ applyUrl: url }));
      expect(result.valid, url).toBe(false);
      expect(result.reason).toContain('unsafe applyUrl');
    }
  });

  it('rejects a Telegram or WhatsApp applyUrl', () => {
    for (const url of [
      'https://t.me/jobsvillaa',
      'https://t.me/jobsvillaa/25587',
      'https://telegram.me/internfreak',
      'https://telegram.dog/internfreak',
      'https://chat.whatsapp.com/ABC123',
    ]) {
      expect(validateClassifiedJob(job({ applyUrl: url })), url).toEqual({
        valid: false,
        reason: 'applyUrl is a Telegram/WhatsApp link',
      });
    }
  });
});
