import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/llm/client.js', () => ({
  isLlmConfigured: vi.fn(() => true),
  generateStructured: vi.fn(),
}));

import { generateStructured, isLlmConfigured } from '../src/llm/client.js';
import { classifyJobPost, sanitizeClassification } from '../src/telegram/job-classifier.js';
import { validateClassifiedJob } from '../src/telegram/job-validator.js';

const mockGenerate = vi.mocked(generateStructured);
const mockConfigured = vi.mocked(isLlmConfigured);

/** Convenience: raw model output with everything "not stated". */
function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isJob: true,
    company: '',
    role: '',
    batch: '',
    applyUrl: '',
    location: '',
    employmentType: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigured.mockReturnValue(true);
});

describe('sanitizeClassification — grounded extraction', () => {
  const post = [
    'Amazon Off Campus Drive 2027',
    'Role: Software Engineering Intern',
    'Location: Bengaluru',
    'Batch: 2027',
    'Apply: https://amazon.jobs/en/jobs/2934120',
  ].join('\n');

  it('keeps every field the post actually states', () => {
    const result = sanitizeClassification(
      raw({
        company: 'Amazon',
        role: 'Software Engineering Intern',
        batch: '2027',
        applyUrl: 'https://amazon.jobs/en/jobs/2934120',
        location: 'Bengaluru',
        employmentType: 'internship',
      }),
      post,
    );

    expect(result).toEqual({
      ok: true,
      job: {
        isJob: true,
        company: 'Amazon',
        role: 'Software Engineering Intern',
        batch: '2027',
        applyUrl: 'https://amazon.jobs/en/jobs/2934120',
        location: 'Bengaluru',
        employmentType: 'internship',
      },
    });
  });

  it('maps "not stated" answers to null', () => {
    const result = sanitizeClassification(raw({ company: 'Amazon' }), post);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job).toMatchObject({
      company: 'Amazon',
      role: null,
      batch: null,
      applyUrl: null,
      location: null,
      employmentType: null,
    });
  });

  it('drops invented values that never appear in the post', () => {
    const result = sanitizeClassification(
      raw({ company: 'Microsoft', role: 'Data Scientist', location: 'Hyderabad' }),
      post,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.company).toBeNull();
    expect(result.job.role).toBeNull();
    expect(result.job.location).toBeNull();
  });

  it('drops stringified absences like "N/A" and "not mentioned"', () => {
    for (const value of ['null', 'None', 'N/A', 'unknown', 'Not mentioned']) {
      const result = sanitizeClassification(raw({ company: value }), post);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.job.company, value).toBeNull();
    }
  });

  it('drops a whole paragraph pasted into a field', () => {
    const result = sanitizeClassification(raw({ role: post }), post);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.role).toBeNull();
  });

  it('normalises employmentType to the closed set and rejects anything else', () => {
    const asType = (value: unknown): string | null => {
      const result = sanitizeClassification(raw({ employmentType: value }), post);
      return result.ok ? result.job.employmentType : 'ERROR';
    };

    expect(asType('Internship')).toBe('internship');
    expect(asType('Full Time')).toBe('full-time');
    expect(asType('freelance')).toBeNull();
    expect(asType('')).toBeNull();
  });

  it('clears all fields when the model says it is not a job', () => {
    const result = sanitizeClassification(
      { isJob: false, company: 'Amazon', role: 'SDE', applyUrl: 'https://amazon.jobs' },
      post,
    );

    expect(result).toEqual({
      ok: true,
      job: {
        isJob: false,
        company: null,
        role: null,
        batch: null,
        applyUrl: null,
        location: null,
        employmentType: null,
      },
    });
  });

  it('reports unusable output instead of storing it', () => {
    expect(sanitizeClassification(null, post)).toEqual({
      ok: false,
      reason: 'LLM output was not an object',
    });
    expect(sanitizeClassification({ isJob: 'yes' }, post)).toEqual({
      ok: false,
      reason: 'LLM output had no boolean isJob',
    });
    expect(sanitizeClassification({}, post)).toEqual({
      ok: false,
      reason: 'LLM output had no boolean isJob',
    });
  });
});

describe('sanitizeClassification — promotion is never data', () => {
  const promoPost = [
    'Amazon SDE Intern hiring 🔥',
    'Join now 👉 https://t.me/somejobchannel',
    'DM @somehandle for collab',
    'WhatsApp group: https://chat.whatsapp.com/ABC123',
  ].join('\n');

  it('never accepts a handle, CTA or chat link as company', () => {
    for (const value of ['@somehandle', 'Join now', 'DM @somehandle', 't.me/somejobchannel']) {
      const result = sanitizeClassification(raw({ company: value }), promoPost);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.job.company, value).toBeNull();
    }
  });

  it('never accepts a Telegram or WhatsApp link as applyUrl', () => {
    for (const value of [
      'https://t.me/somejobchannel',
      't.me/somejobchannel',
      'https://chat.whatsapp.com/ABC123',
    ]) {
      const result = sanitizeClassification(raw({ applyUrl: value }), promoPost);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.job.applyUrl, value).toBeNull();
    }
  });

  it('never accepts an unsafe scheme as applyUrl', () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd']) {
      const result = sanitizeClassification(raw({ applyUrl: value }), promoPost);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.job.applyUrl, value).toBeNull();
    }
  });

  it('rejects an applyUrl the post never contained', () => {
    const result = sanitizeClassification(
      raw({ applyUrl: 'https://bit.ly/made-up-link' }),
      promoPost,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.applyUrl).toBeNull();
  });

  it('accepts a real link the model copied without its scheme', () => {
    const post = 'Zoho hiring | Register at careers.zohocorp.com/jobs/42';
    const result = sanitizeClassification(raw({ applyUrl: 'careers.zohocorp.com/jobs/42' }), post);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.applyUrl).toBe('https://careers.zohocorp.com/jobs/42');
  });

  it('strips punctuation the model carried over from the post', () => {
    const post = 'Apply here: https://careers.example.com/apply/9.';
    const result = sanitizeClassification(
      raw({ applyUrl: 'https://careers.example.com/apply/9.' }),
      post,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.applyUrl).toBe('https://careers.example.com/apply/9');
  });
});

describe('classifyJobPost', () => {
  const post = 'Infosys is hiring System Engineer for 2026 batch';

  it('returns the sanitized job on a usable response', async () => {
    mockGenerate.mockResolvedValue({
      ok: true,
      data: raw({ company: 'Infosys', role: 'System Engineer', batch: '2026' }),
    });

    const result = await classifyJobPost(post);

    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job).toMatchObject({
      isJob: true,
      company: 'Infosys',
      role: 'System Engineer',
      batch: '2026',
    });
    expect(validateClassifiedJob(result.job)).toEqual({ valid: true });
  });

  it('does not call the provider when no API key is configured', async () => {
    mockConfigured.mockReturnValue(false);

    const result = await classifyJobPost(post);

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      reason: 'LLM not configured (GEMINI_API_KEY is not set)',
    });
  });

  it('passes a provider failure through as a reason instead of throwing', async () => {
    mockGenerate.mockResolvedValue({ ok: false, reason: 'LLM request timed out after 20000ms' });

    await expect(classifyJobPost(post)).resolves.toEqual({
      ok: false,
      reason: 'LLM request timed out after 20000ms',
    });
  });

  it('rejects malformed output rather than storing it', async () => {
    mockGenerate.mockResolvedValue({ ok: true, data: { company: 'Infosys' } });

    const result = await classifyJobPost(post);

    expect(result).toEqual({ ok: false, reason: 'LLM output had no boolean isJob' });
  });

  it('a promo post classified as a job still fails validation with no grounded fields', async () => {
    const promo = 'Join our channel @bestjobs for daily updates! DM for promotion.';
    mockGenerate.mockResolvedValue({
      ok: true,
      data: raw({ company: '@bestjobs', role: 'Join our channel' }),
    });

    const result = await classifyJobPost(promo);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.job.company).toBeNull();
    expect(result.job.role).toBeNull();
    expect(validateClassifiedJob(result.job)).toEqual({
      valid: false,
      reason: 'neither company nor role could be extracted',
    });
  });
});
