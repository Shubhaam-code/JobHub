/**
 * Candidate profile routes: resume upload, read, and manual preference edits.
 *
 * Every route here is scoped to the caller's own profile. `requireProfile`
 * resolves the profile from the bearer token alone and no handler accepts a
 * profile id, so there is no request shape that reaches another candidate's
 * data.
 *
 * The resume file is parsed in-process and then discarded — it is never written
 * to disk or object storage, so there is no private resume URL that could leak
 * through any API.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express';

import { env } from '../config/env.js';
import { badRequest, HttpError } from '../lib/http-error.js';
import { logger } from '../lib/logger.js';
import { createProfileToken, hashProfileToken, readBearerToken } from '../lib/profile-token.js';
import { requireProfile, type ProfileRequest } from '../middleware/require-profile.js';
import {
  CandidateProfileModel,
  EDITABLE_PROFILE_FIELDS,
  type CandidateProfileDocument,
  type EditableProfileField,
} from '../models/candidate-profile.model.js';
import { normalizeSkillList } from '../recommendations/skill-dictionary.js';
import { extractPdfText } from '../resume/pdf-text.js';
import { parseResume } from '../resume/resume-parser.js';

export const profileRouter = Router();

/** Caps on hand-entered preferences, so a profile cannot be used as storage. */
const MAX_LIST_LENGTH = 30;
const MAX_ENTRY_LENGTH = 60;
const MAX_FILENAME_LENGTH = 120;

/**
 * The profile as the API describes it.
 *
 * `tokenHash` is deliberately absent: it is the credential's fingerprint and has
 * no business in a response body.
 */
interface PublicProfile {
  skills: string[];
  preferredRoles: string[];
  preferredLocations: string[];
  preferredJobTypes: string[];
  experienceYears: number | null;
  graduationYear: string | null;
  /** Name of the last resume parsed, for display only — never a URL. */
  resumeFileName: string | null;
  resumeParsedAt: string | null;
  hasResume: boolean;
  /** Fields the user has edited by hand; a later upload leaves these alone. */
  manualFields: string[];
}

function formatProfile(profile: CandidateProfileDocument): PublicProfile {
  return {
    skills: profile.skills ?? [],
    preferredRoles: profile.preferredRoles ?? [],
    preferredLocations: profile.preferredLocations ?? [],
    preferredJobTypes: profile.preferredJobTypes ?? [],
    experienceYears: profile.experienceYears ?? null,
    graduationYear: profile.graduationYear ?? null,
    resumeFileName: profile.resumeFileName ?? null,
    resumeParsedAt: profile.resumeParsedAt?.toISOString() ?? null,
    hasResume: profile.resumeParsedAt !== null && profile.resumeParsedAt !== undefined,
    manualFields: profile.manualFields ?? [],
  };
}

/**
 * Reads the request body as raw PDF bytes.
 *
 * The `type` filter is the file-type check: a request that is not declared as
 * `application/pdf` never reaches a parser, and `limit` rejects an oversized
 * upload before it is buffered rather than after.
 */
const readPdfBody = express.raw({
  type: 'application/pdf',
  limit: env.RESUME_MAX_BYTES,
});

function readResumeUpload(req: Request, res: Response, next: NextFunction): void {
  readPdfBody(req, res, (error?: unknown) => {
    if (error === undefined || error === null) {
      next();
      return;
    }

    const status = (error as { status?: number; statusCode?: number }).status;
    if (status === 413 || (error as { statusCode?: number }).statusCode === 413) {
      const limitMb = (env.RESUME_MAX_BYTES / 1_000_000).toFixed(1).replace(/\.0$/, '');
      next(new HttpError(413, `That resume is too large. The limit is ${limitMb} MB.`));
      return;
    }

    next(error);
  });
}

/** Strips any path and keeps a plain, bounded `.pdf` name, or null. */
function sanitizeFileName(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;

  const base = value.split(/[/\\]/).pop()?.trim() ?? '';
  if (base.length === 0 || base.length > MAX_FILENAME_LENGTH) return null;
  if (!/^[\w .()-]+\.pdf$/i.test(base)) return null;

  return base;
}

/**
 * Finds the caller's profile when they already have one.
 *
 * Unlike `requireProfile` this tolerates an absent token, because the very first
 * upload has no profile to authenticate against yet.
 */
async function findProfileByToken(req: Request): Promise<CandidateProfileDocument | null> {
  const token = readBearerToken(req.get('authorization'));
  if (token === null) return null;

  return CandidateProfileModel.findOne({ tokenHash: hashProfileToken(token) });
}

function asStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw badRequest(`${field} must be an array of strings.`);
  }

  if (value.length > MAX_LIST_LENGTH) {
    throw badRequest(`${field} may contain at most ${MAX_LIST_LENGTH} entries.`);
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw badRequest(`${field} must be an array of strings.`);
    }

    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;

    if (trimmed.length > MAX_ENTRY_LENGTH) {
      throw badRequest(`Each ${field} entry must be ${MAX_ENTRY_LENGTH} characters or fewer.`);
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function asExperienceYears(value: unknown): number | null {
  if (value === null || value === '') return null;

  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 50) {
    throw badRequest('experienceYears must be a number between 0 and 50, or null.');
  }

  return Math.round(numeric * 2) / 2;
}

function asGraduationYear(value: unknown): string | null {
  if (value === null || value === '') return null;

  const text = String(value).trim();
  if (!/^\d{4}$/.test(text)) {
    throw badRequest('graduationYear must be a 4-digit year, or null.');
  }

  const year = Number(text);
  if (year < 1950 || year > 2100) {
    throw badRequest('graduationYear must be a plausible year.');
  }

  return text;
}

/**
 * POST /api/v1/profile/resume
 *
 * Body is the raw PDF (`Content-Type: application/pdf`). The resume is parsed
 * once, here — never per job — and only the extracted fields are kept.
 *
 * With no bearer token this creates a profile and returns a new token, which is
 * how a first-time visitor gets one. With a token it updates that profile in
 * place, leaving any field the user has edited by hand untouched.
 */
profileRouter.post('/resume', readResumeUpload, async (req: Request, res: Response) => {
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    throw badRequest('Send your resume as a PDF with Content-Type: application/pdf.');
  }

  const extracted = await extractPdfText(req.body);
  if (!extracted.ok) {
    // A bad PDF is the user's problem to fix, so it is a 400 with the reason.
    throw badRequest(extracted.reason);
  }

  const parsed = await parseResume(extracted.text);
  if (!parsed.ok) {
    // Upstream problem, not a malformed request: 503 so the client can retry.
    throw new HttpError(503, parsed.reason);
  }

  const existing = await findProfileByToken(req);
  const profile = existing ?? new CandidateProfileModel();
  let token: string | undefined;

  if (existing === null) {
    token = createProfileToken();
    profile.tokenHash = hashProfileToken(token);
  }

  // Manual edits win: re-uploading a resume must never silently undo a choice
  // the user made by hand.
  const manualFields = new Set<string>(profile.manualFields ?? []);

  if (!manualFields.has('skills')) profile.skills = parsed.profile.skills;
  if (!manualFields.has('preferredRoles')) profile.preferredRoles = parsed.profile.preferredRoles;
  if (!manualFields.has('preferredLocations')) {
    profile.preferredLocations = parsed.profile.preferredLocations;
  }
  if (!manualFields.has('preferredJobTypes')) {
    profile.preferredJobTypes = parsed.profile.preferredJobTypes;
  }
  if (!manualFields.has('experienceYears')) {
    profile.experienceYears = parsed.profile.experienceYears;
  }
  if (!manualFields.has('graduationYear')) {
    profile.graduationYear = parsed.profile.graduationYear;
  }

  profile.resumeFileName = sanitizeFileName(req.get('x-resume-filename'));
  profile.resumeParsedAt = new Date();

  await profile.save();

  logger.info(
    `[profile] resume parsed: ${profile.skills?.length ?? 0} skills, ` +
      `${profile.preferredRoles?.length ?? 0} roles`,
  );

  res.status(existing === null ? 201 : 200).json({
    data: formatProfile(profile),
    // Returned once, on creation. The client stores it; the API keeps only its hash.
    ...(token === undefined ? {} : { token }),
  });
});

/**
 * GET /api/v1/profile
 * The caller's own profile.
 */
profileRouter.get('/', requireProfile, (req: Request, res: Response) => {
  res.status(200).json({ data: formatProfile((req as ProfileRequest).candidateProfile) });
});

/**
 * PUT /api/v1/profile
 *
 * Updates preferences. Every field is optional — nothing here is mandatory, and
 * a user who never uploads a resume can fill this in by hand instead.
 *
 * Any field present in the body is recorded in `manualFields`, which is what
 * makes manual input win over a later resume upload.
 */
profileRouter.put('/', requireProfile, async (req: Request, res: Response) => {
  const body: unknown = req.body;

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('Request body must be a JSON object.');
  }

  const payload = body as Record<string, unknown>;
  const profile = (req as ProfileRequest).candidateProfile;
  const manualFields = new Set<string>(profile.manualFields ?? []);
  let changed = false;

  const touch = (field: EditableProfileField): void => {
    manualFields.add(field);
    changed = true;
  };

  if ('skills' in payload) {
    profile.skills = normalizeSkillList(asStringList(payload['skills'], 'skills'));
    touch('skills');
  }

  if ('preferredRoles' in payload) {
    profile.preferredRoles = asStringList(payload['preferredRoles'], 'preferredRoles');
    touch('preferredRoles');
  }

  if ('preferredLocations' in payload) {
    profile.preferredLocations = asStringList(payload['preferredLocations'], 'preferredLocations');
    touch('preferredLocations');
  }

  if ('preferredJobTypes' in payload) {
    profile.preferredJobTypes = asStringList(payload['preferredJobTypes'], 'preferredJobTypes');
    touch('preferredJobTypes');
  }

  if ('experienceYears' in payload) {
    profile.experienceYears = asExperienceYears(payload['experienceYears']);
    touch('experienceYears');
  }

  if ('graduationYear' in payload) {
    profile.graduationYear = asGraduationYear(payload['graduationYear']);
    touch('graduationYear');
  }

  if (!changed) {
    throw badRequest(`Provide at least one of: ${EDITABLE_PROFILE_FIELDS.join(', ')}.`);
  }

  profile.manualFields = [...manualFields];
  await profile.save();

  res.status(200).json({ data: formatProfile(profile) });
});
