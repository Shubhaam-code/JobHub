import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { hashProfileToken } from '../src/lib/profile-token.js';
import { CandidateProfileModel } from '../src/models/candidate-profile.model.js';
import * as resumeParser from '../src/resume/resume-parser.js';
import { makePdf, SAMPLE_RESUME_LINES } from './helpers/make-pdf.js';

const app = createApp();

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

/** A parsed resume, as the LLM step would return it. */
const PARSED = {
  skills: ['Java', 'Spring Boot', 'MongoDB'],
  preferredRoles: ['Backend Developer'],
  preferredLocations: ['Bengaluru'],
  preferredJobTypes: ['internship'],
  experienceYears: 0,
  graduationYear: '2026',
};

/** A real (unsaved) profile document, so field logic runs for real. */
function makeProfileDoc(overrides: Record<string, unknown> = {}) {
  return new CandidateProfileModel({
    tokenHash: hashProfileToken(TOKEN_A),
    skills: [],
    preferredRoles: [],
    preferredLocations: [],
    preferredJobTypes: [],
    experienceYears: null,
    graduationYear: null,
    manualFields: [],
    ...overrides,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Nothing here touches MongoDB: save() is stubbed and findOne() is mocked.
  vi.spyOn(CandidateProfileModel.prototype, 'save').mockImplementation(async function (this: unknown) {
    return this;
  } as never);
});

describe('POST /api/v1/profile/resume', () => {
  it('TEST 1: a valid PDF creates a profile and returns a token once', async () => {
    vi.spyOn(resumeParser, 'parseResume').mockResolvedValue({ ok: true, profile: PARSED });
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(null as never);

    const response = await request(app)
      .post('/api/v1/profile/resume')
      .set('Content-Type', 'application/pdf')
      .set('X-Resume-Filename', 'aarav-resume.pdf')
      .send(makePdf(SAMPLE_RESUME_LINES));

    expect(response.status).toBe(201);
    expect(response.body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(response.body.data.skills).toEqual(['Java', 'Spring Boot', 'MongoDB']);
    expect(response.body.data.preferredRoles).toEqual(['Backend Developer']);
    expect(response.body.data.preferredLocations).toEqual(['Bengaluru']);
    expect(response.body.data.preferredJobTypes).toEqual(['internship']);
    expect(response.body.data.graduationYear).toBe('2026');
    expect(response.body.data.resumeFileName).toBe('aarav-resume.pdf');
    expect(response.body.data.hasResume).toBe(true);
  });

  it('never returns the token hash', async () => {
    vi.spyOn(resumeParser, 'parseResume').mockResolvedValue({ ok: true, profile: PARSED });
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(null as never);

    const response = await request(app)
      .post('/api/v1/profile/resume')
      .set('Content-Type', 'application/pdf')
      .send(makePdf(SAMPLE_RESUME_LINES));

    expect(response.body.data).not.toHaveProperty('tokenHash');
    expect(JSON.stringify(response.body)).not.toContain(hashProfileToken(TOKEN_A));
  });

  it('rejects a non-PDF upload with a useful message', async () => {
    const response = await request(app)
      .post('/api/v1/profile/resume')
      .set('Content-Type', 'application/pdf')
      .send(Buffer.from('PK this is a docx', 'latin1'));

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('not a PDF');
  });

  it('rejects a wrong content type rather than parsing it', async () => {
    const response = await request(app)
      .post('/api/v1/profile/resume')
      .set('Content-Type', 'application/json')
      .send({ resume: 'nope' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('application/pdf');
  });

  it('reports a parse failure as a retryable 503, not a crash', async () => {
    vi.spyOn(resumeParser, 'parseResume').mockResolvedValue({
      ok: false,
      reason: 'Your resume could not be analysed. Please try again, or set your preferences by hand.',
    });

    const response = await request(app)
      .post('/api/v1/profile/resume')
      .set('Content-Type', 'application/pdf')
      .send(makePdf(SAMPLE_RESUME_LINES));

    expect(response.status).toBe(503);
    expect(response.body.error.message).toContain('could not be analysed');
  });

  it('does not overwrite a field the user edited by hand', async () => {
    const existing = makeProfileDoc({
      preferredLocations: ['Remote'],
      manualFields: ['preferredLocations'],
    });
    vi.spyOn(resumeParser, 'parseResume').mockResolvedValue({ ok: true, profile: PARSED });
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(existing as never);

    const response = await request(app)
      .post('/api/v1/profile/resume')
      .set('Content-Type', 'application/pdf')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send(makePdf(SAMPLE_RESUME_LINES));

    expect(response.status).toBe(200);
    // Manual choice survives; a non-manual field is refreshed from the resume.
    expect(response.body.data.preferredLocations).toEqual(['Remote']);
    expect(response.body.data.skills).toEqual(['Java', 'Spring Boot', 'MongoDB']);
    // No second token is minted for an existing profile.
    expect(response.body.token).toBeUndefined();
  });
});

describe('GET /api/v1/profile', () => {
  it('requires a token', async () => {
    const response = await request(app).get('/api/v1/profile');

    expect(response.status).toBe(401);
    expect(response.body.error.message).toContain('profile token');
  });

  it('rejects a malformed token without a database lookup', async () => {
    const findOne = vi.spyOn(CandidateProfileModel, 'findOne');

    const response = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(response.status).toBe(401);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(null as never);

    const response = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(response.status).toBe(401);
  });

  it('TEST 2: returns the extracted data for the caller', async () => {
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(
      makeProfileDoc({ ...PARSED, resumeParsedAt: new Date('2026-08-31T10:00:00.000Z') }) as never,
    );

    const response = await request(app)
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${TOKEN_A}`);

    expect(response.status).toBe(200);
    expect(response.body.data.skills).toEqual(['Java', 'Spring Boot', 'MongoDB']);
    expect(response.body.data.hasResume).toBe(true);
  });

  it('looks a profile up by the caller’s own token hash only', async () => {
    const findOne = vi
      .spyOn(CandidateProfileModel, 'findOne')
      .mockResolvedValue(makeProfileDoc() as never);

    await request(app).get('/api/v1/profile').set('Authorization', `Bearer ${TOKEN_B}`);

    // The query is derived from the bearer token and nothing else, so there is
    // no input that could name another candidate's profile.
    expect(findOne).toHaveBeenCalledWith({ tokenHash: hashProfileToken(TOKEN_B) });
  });
});

describe('PUT /api/v1/profile', () => {
  it('requires a token', async () => {
    const response = await request(app).put('/api/v1/profile').send({ skills: ['Java'] });

    expect(response.status).toBe(401);
  });

  it('updates preferences and records them as manual', async () => {
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(makeProfileDoc() as never);

    const response = await request(app)
      .put('/api/v1/profile')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ preferredLocations: ['Remote'], skills: ['nodejs', 'Node.js'] });

    expect(response.status).toBe(200);
    expect(response.body.data.preferredLocations).toEqual(['Remote']);
    // Skills are canonicalized and de-duplicated on the way in.
    expect(response.body.data.skills).toEqual(['Node.js']);
    expect(response.body.data.manualFields.sort()).toEqual(['preferredLocations', 'skills']);
  });

  it('allows clearing a preference', async () => {
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(
      makeProfileDoc({ preferredLocations: ['Bengaluru'] }) as never,
    );

    const response = await request(app)
      .put('/api/v1/profile')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ preferredLocations: [] });

    expect(response.status).toBe(200);
    expect(response.body.data.preferredLocations).toEqual([]);
  });

  it('rejects a non-array preference', async () => {
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(makeProfileDoc() as never);

    const response = await request(app)
      .put('/api/v1/profile')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ skills: 'Java' });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toContain('array of strings');
  });

  it('rejects an implausible graduation year', async () => {
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(makeProfileDoc() as never);

    const response = await request(app)
      .put('/api/v1/profile')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({ graduationYear: '99' });

    expect(response.status).toBe(400);
  });

  it('rejects an empty update', async () => {
    vi.spyOn(CandidateProfileModel, 'findOne').mockResolvedValue(makeProfileDoc() as never);

    const response = await request(app)
      .put('/api/v1/profile')
      .set('Authorization', `Bearer ${TOKEN_A}`)
      .send({});

    expect(response.status).toBe(400);
  });
});
