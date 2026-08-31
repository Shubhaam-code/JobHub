/**
 * Resume text → structured candidate profile, via Groq.
 *
 * Runs exactly once per upload. Nothing in the recommendation path calls an LLM,
 * so this is the only model call the whole feature makes.
 *
 * Groq is the only provider on this path — there is no second provider and no
 * fallback. The model's answer is never trusted as-is: every skill, role and
 * location is re-checked against the resume text with the same grounding helper
 * the job classifier uses, so a plausible-but-absent skill cannot enter a
 * profile and then quietly drive recommendations.
 */

import type { JsonSchema } from '../llm/client.js';
import { generateStructuredWithGroq, isGroqConfigured } from '../llm/groq-client.js';
import { JOB_TYPES, normalizeJobType } from '../recommendations/matching.js';
import { normalizeSkillList } from '../recommendations/skill-dictionary.js';
import { isGroundedIn } from '../telegram/text-safety.js';

/** Exactly the six fields the candidate profile stores. */
export interface ParsedResume {
  skills: string[];
  preferredRoles: string[];
  preferredLocations: string[];
  preferredJobTypes: string[];
  experienceYears: number | null;
  graduationYear: string | null;
}

export type ResumeParseResult =
  | { ok: true; profile: ParsedResume }
  | { ok: false; reason: string; rateLimited?: boolean; retryAfterMs?: number };

/** Caps: a resume listing more than this is padding, and the rest adds nothing. */
const MAX_SKILLS = 25;
const MAX_ROLES = 5;
const MAX_LOCATIONS = 5;
const MAX_FIELD_LENGTH = 60;

/** Several arrays do not fit in the default ceiling — the JSON would truncate. */
const MAX_OUTPUT_TOKENS = 1_500;

/** Resume text is already capped by the extractor; this is a second guard. */
const MAX_PROMPT_CHARS = 12_000;

const RESUME_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    skills: {
      type: 'array',
      description: 'Technical skills, tools and technologies named in the resume.',
      items: { type: 'string' },
    },
    preferredRoles: {
      type: 'array',
      description: 'Job titles the candidate targets, from an objective line or their experience.',
      items: { type: 'string' },
    },
    preferredLocations: {
      type: 'array',
      description: 'Locations named in the resume (city, or Remote if stated).',
      items: { type: 'string' },
    },
    preferredJobTypes: {
      type: 'array',
      description: 'Employment types the candidate seeks.',
      items: { type: 'string', enum: [...JOB_TYPES] },
    },
    experienceYears: {
      type: 'number',
      description:
        'Total years of professional or internship experience. Use 0 for a fresher with none. Use -1 if it cannot be determined.',
    },
    graduationYear: {
      type: 'string',
      description: 'Graduation year as a 4-digit year, e.g. "2026". Use "" if not stated.',
    },
  },
  required: [
    'skills',
    'preferredRoles',
    'preferredLocations',
    'preferredJobTypes',
    'experienceYears',
    'graduationYear',
  ],
  additionalProperties: false,
};

const SYSTEM_INSTRUCTION = [
  'You extract a job-matching profile from resume text.',
  '',
  'Extraction rules:',
  '- Only report what the resume states, or what follows directly from it.',
  '- Never invent a skill. If a technology is not named in the resume, it does not exist.',
  '  Do not add skills that "usually go with" the ones listed: a resume naming Java',
  '  does not imply Spring, and one naming React does not imply Redux.',
  '- skills: technical skills, languages, frameworks, databases and tools only.',
  '  Not soft skills, not job duties, not degree names.',
  '- preferredRoles: the position titles the candidate is aiming for. Take them from an',
  '  objective/summary line when present, otherwise from the titles they have held.',
  '  Give the plain title ("Backend Developer"), without company, level or location.',
  '- preferredLocations: locations the resume names as where they are or want to work.',
  '  "Remote" counts. Do not guess a city from a college or company name.',
  `- preferredJobTypes: only from ${JOB_TYPES.join(', ')}, and only when the resume`,
  '  indicates it (e.g. an objective asking for an internship, or only internship experience).',
  '- experienceYears: total years worked, counting internships. 0 for a fresher. -1 if unclear.',
  '- graduationYear: the 4-digit year they graduate or graduated. "" if the resume omits it.',
  '',
  'An empty array or "" is always better than a guess. Missing fields are expected and fine.',
  '',
  'Answer with the JSON object only.',
].join('\n');

function buildPrompt(text: string): string {
  const body = text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}…` : text;
  return `Resume text:\n"""\n${body}\n"""`;
}

/** Raw model output before any checking. */
interface RawResume {
  skills?: unknown;
  preferredRoles?: unknown;
  preferredLocations?: unknown;
  preferredJobTypes?: unknown;
  experienceYears?: unknown;
  graduationYear?: unknown;
}

/** Stringified absences a model returns instead of omitting a value. */
const ABSENT_VALUE_REGEX =
  /^(null|none|n\/?a|nil|unknown|not\s+(?:mentioned|specified|stated|applicable))$/i;

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return ABSENT_VALUE_REGEX.test(trimmed) ? null : trimmed;
}

/**
 * Keeps the entries of a string array that are short, real and present in the
 * resume. Grounding is the anti-hallucination check: an unstated skill is
 * dropped rather than stored.
 */
function acceptGroundedList(value: unknown, resumeText: string, limit: number): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const accepted: string[] = [];

  for (const entry of value) {
    const candidate = asTrimmedString(entry);
    if (candidate === null) continue;
    if (candidate.length > MAX_FIELD_LENGTH) continue;
    if (!isGroundedIn(candidate, resumeText)) continue;

    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    accepted.push(candidate);

    if (accepted.length >= limit) break;
  }

  return accepted;
}

/**
 * Job types are a closed set, so they are validated rather than grounded — a
 * resume can imply "internship" without containing the word.
 */
function acceptJobTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const accepted: string[] = [];

  for (const entry of value) {
    const candidate = asTrimmedString(entry);
    if (candidate === null) continue;

    const normalized = normalizeJobType(candidate);
    if (normalized === null || accepted.includes(normalized)) continue;

    accepted.push(normalized);
  }

  return accepted;
}

/** Accepts a plausible year count; -1 and nonsense both become null. */
function acceptExperienceYears(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(asTrimmedString(value) ?? NaN);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 0 || numeric > 50) return null;

  // Half-years are real ("6 months" -> 0.5); anything finer is noise.
  return Math.round(numeric * 2) / 2;
}

/** Accepts a 4-digit year that actually appears in the resume. */
function acceptGraduationYear(value: unknown, resumeText: string): string | null {
  const candidate = asTrimmedString(value);
  if (candidate === null) return null;
  if (!/^\d{4}$/.test(candidate)) return null;

  const year = Number(candidate);
  if (year < 1950 || year > 2100) return null;

  return resumeText.includes(candidate) ? candidate : null;
}

/**
 * Turns raw model output into a `ParsedResume`.
 *
 * Never fails the whole profile over one bad field: an unusable value becomes an
 * empty array or null, because a partial profile still produces useful
 * recommendations and the user can fill in the rest by hand.
 *
 * Exported for tests; the parse path always goes through `parseResume`.
 */
export function sanitizeParsedResume(
  raw: RawResume | null | undefined,
  resumeText: string,
): ParsedResume {
  if (raw === null || typeof raw !== 'object') {
    return {
      skills: [],
      preferredRoles: [],
      preferredLocations: [],
      preferredJobTypes: [],
      experienceYears: null,
      graduationYear: null,
    };
  }

  return {
    skills: normalizeSkillList(acceptGroundedList(raw.skills, resumeText, MAX_SKILLS)),
    preferredRoles: acceptGroundedList(raw.preferredRoles, resumeText, MAX_ROLES),
    preferredLocations: acceptGroundedList(raw.preferredLocations, resumeText, MAX_LOCATIONS),
    preferredJobTypes: acceptJobTypes(raw.preferredJobTypes),
    experienceYears: acceptExperienceYears(raw.experienceYears),
    graduationYear: acceptGraduationYear(raw.graduationYear, resumeText),
  };
}

/**
 * Parses one resume's text into a profile.
 *
 * Never throws: a missing key, provider failure, timeout or unusable output all
 * come back as `{ ok: false, reason }` so the upload route can answer with a
 * clear message instead of a 500.
 */
export async function parseResume(resumeText: string): Promise<ResumeParseResult> {
  if (!isGroqConfigured()) {
    return {
      ok: false,
      reason: 'Resume parsing is unavailable right now. You can still set your preferences by hand.',
    };
  }

  const response = await generateStructuredWithGroq<RawResume>({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: buildPrompt(resumeText),
    schema: RESUME_SCHEMA,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: response.rateLimited === true
        ? 'Resume parsing is busy right now. Please try again in a minute.'
        : 'Your resume could not be analysed. Please try again, or set your preferences by hand.',
      ...(response.rateLimited === true ? { rateLimited: true } : {}),
      ...(response.retryAfterMs !== undefined ? { retryAfterMs: response.retryAfterMs } : {}),
    };
  }

  return { ok: true, profile: sanitizeParsedResume(response.data, resumeText) };
}
