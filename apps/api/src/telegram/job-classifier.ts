/**
 * LLM job classification + field extraction.
 *
 * One generic path for every channel: the post text goes to the LLM, which
 * decides whether it is a genuine job/internship and extracts only the fields
 * the post states. Nothing here knows or cares which channel a post came from.
 *
 * The model's answer is never trusted as-is: every returned value is re-checked
 * against the original text (grounding) and against the deterministic safety
 * rules before it can become a stored field.
 */

import { generateStructured, isLlmConfigured, type JsonSchema } from '../llm/client.js';
import {
  isApplyUrlCandidate,
  isGroundedIn,
  isPromotionalValue,
  LINK_HINT_REGEX,
} from './text-safety.js';

export interface ClassifiedJob {
  isJob: boolean;
  company: string | null;
  role: string | null;
  batch: string | null;
  applyUrl: string | null;
  location: string | null;
  employmentType: string | null;
}

export type ClassificationResult =
  | { ok: true; job: ClassifiedJob }
  | {
      ok: false;
      reason: string;
      /** True when the provider returned 429 — worth retrying later, not dropping. */
      rateLimited?: boolean;
      /** Wait the provider asked for, when it supplied one. */
      retryAfterMs?: number;
    };

/** Closed set for employmentType — the one field the model may normalise. */
const EMPLOYMENT_TYPES = [
  'internship',
  'full-time',
  'part-time',
  'contract',
  'apprenticeship',
  'training',
] as const;

/** Longest values worth storing; anything longer is a captured paragraph. */
const MAX_COMPANY_LENGTH = 80;
const MAX_FIELD_LENGTH = 120;

/**
 * The model answers with all seven keys, using "" for anything the post does
 * not state. Empty strings (rather than nulls) keep the schema portable and are
 * mapped back to null below.
 */
const CLASSIFICATION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    isJob: {
      type: 'boolean',
      description: 'True only for a genuine job or internship opportunity.',
    },
    company: { type: 'string', description: 'Hiring company name, or "" if not stated.' },
    role: { type: 'string', description: 'Job/internship title, or "" if not stated.' },
    batch: {
      type: 'string',
      description: 'Eligible graduation year(s) exactly as written, e.g. "2027" or "2026 & 2027".',
    },
    applyUrl: {
      type: 'string',
      description: 'Application/registration URL copied verbatim from the post, or "".',
    },
    location: { type: 'string', description: 'Work location as written, or "".' },
    employmentType: {
      type: 'string',
      description: 'One of the listed values, or "" if the post does not make it clear.',
      enum: ['', ...EMPLOYMENT_TYPES],
    },
  },
  required: ['isJob', 'company', 'role', 'batch', 'applyUrl', 'location', 'employmentType'],
  additionalProperties: false,
};

const SYSTEM_INSTRUCTION = [
  'You classify posts from Telegram job channels and extract structured fields.',
  'Channels use wildly different formats: structured "Company:/Role:" blocks, plain',
  'headlines, all-caps banners, emoji-heavy posts. Judge the meaning, not the layout.',
  '',
  'Set isJob=true when the post announces a real job, internship, off-campus drive,',
  'placement drive, walk-in, hiring event or open position that a candidate can pursue.',
  'Headline-only posts count: "Google Off Campus Drive 2027", "Accenture is hiring freshers",',
  '"Software Engineer - Apply Now" are all isJob=true even with no other detail.',
  '',
  'Set isJob=false for everything else, including: channel promotion ("Join our Telegram",',
  '"Subscribe", "Follow our page", "Join WhatsApp group"), collaboration/advertisement/promotion',
  'requests ("DM for promotion", "Message here for collab"), greetings, motivational posts,',
  'interview preparation tips, resume tips, roadmaps, course/certificate offers, results and',
  'news with no open position.',
  '',
  'A Telegram username (@handle), a t.me / telegram.me / telegram.dog link, a WhatsApp link,',
  '"Join Now", "Join channel", "DM", "collab", "promotion" or "advertisement" is NEVER evidence',
  'of a job on its own, is NEVER a company name, and is NEVER an application URL.',
  '',
  'Extraction rules:',
  '- Copy values from the post. Never infer, translate, expand, complete or invent anything.',
  '- If the post does not state a field, return "" for it. "" is always better than a guess.',
  '- company: the hiring employer only. Not the channel, not a handle, not a recruiter CTA.',
  '- role: the position title only, without company, location, batch or salary.',
  '- batch: graduation year(s) exactly as written.',
  '- applyUrl: the application/registration link, copied character for character from the post.',
  '  Never a Telegram or WhatsApp link. "" when the post has no application link.',
  '- location: the stated work location. "Remote"/"WFH" count as locations.',
  `- employmentType: one of ${EMPLOYMENT_TYPES.join(', ')} when clear, otherwise "".`,
  '',
  'Answer with the JSON object only.',
].join('\n');

/** Long posts are truncated: the classifying detail is always near the top. */
const MAX_PROMPT_CHARS = 4_000;

function buildPrompt(text: string): string {
  const body = text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}…` : text;
  return `Telegram post:\n"""\n${body}\n"""`;
}

/** Raw model output before any checking. */
interface RawClassification {
  isJob?: unknown;
  company?: unknown;
  role?: unknown;
  batch?: unknown;
  applyUrl?: unknown;
  location?: unknown;
  employmentType?: unknown;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Accepts a text field only when it is safe, plausibly short, and actually
 * present in the post. Grounding is what stops a hallucinated employer or role
 * from being stored.
 */
function acceptTextField(value: unknown, originalText: string, maxLength: number): string | null {
  const candidate = asTrimmedString(value);
  if (candidate === null) return null;
  if (candidate.length > maxLength) return null;
  // "null"/"n/a" are stringified absences, not values.
  if (/^(null|none|n\/?a|unknown|not\s+(?:mentioned|specified|stated))$/i.test(candidate)) {
    return null;
  }
  if (isPromotionalValue(candidate)) return null;
  if (LINK_HINT_REGEX.test(candidate)) return null;
  if (!isGroundedIn(candidate, originalText)) return null;

  return candidate;
}

/** Trailing punctuation a model may carry over when copying a URL. */
const URL_TRAILING_JUNK_REGEX = /[.,;:!?)\]}'"…]+$/;

/**
 * Accepts an application URL only when it is http(s), is not a Telegram or
 * WhatsApp link, and appears in the post. Host+path are compared so a model
 * that adds a missing scheme is not punished for it.
 */
function acceptApplyUrl(value: unknown, originalText: string): string | null {
  const candidate = asTrimmedString(value)?.replace(URL_TRAILING_JUNK_REGEX, '');
  if (!candidate) return null;

  const withScheme = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  if (!isApplyUrlCandidate(withScheme)) return null;

  const bare = withScheme
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();

  if (!originalText.toLowerCase().includes(bare)) return null;

  return withScheme;
}

function acceptEmploymentType(value: unknown): string | null {
  const candidate = asTrimmedString(value)?.toLowerCase().replace(/\s+/g, '-') ?? null;
  if (candidate === null) return null;
  return (EMPLOYMENT_TYPES as readonly string[]).includes(candidate) ? candidate : null;
}

/**
 * Turns raw model output into a `ClassifiedJob`, or reports why it is unusable.
 * Exported for tests — the classification path itself always goes through
 * `classifyJobPost`.
 */
export function sanitizeClassification(
  raw: RawClassification | null | undefined,
  originalText: string,
): ClassificationResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'LLM output was not an object' };
  }

  if (typeof raw.isJob !== 'boolean') {
    return { ok: false, reason: 'LLM output had no boolean isJob' };
  }

  if (!raw.isJob) {
    // Fields are dropped on purpose: a non-job must not contribute any data.
    return {
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
    };
  }

  return {
    ok: true,
    job: {
      isJob: true,
      company: acceptTextField(raw.company, originalText, MAX_COMPANY_LENGTH),
      role: acceptTextField(raw.role, originalText, MAX_FIELD_LENGTH),
      batch: acceptTextField(raw.batch, originalText, MAX_FIELD_LENGTH),
      applyUrl: acceptApplyUrl(raw.applyUrl, originalText),
      location: acceptTextField(raw.location, originalText, MAX_FIELD_LENGTH),
      employmentType: acceptEmploymentType(raw.employmentType),
    },
  };
}

export interface ClassifyOptions {
  /**
   * Attempts inside the LLM call. The queue worker passes 1 so a rate limit is
   * reported back immediately and the durable queue owns the retry, instead of
   * the call sleeping and blocking the worker.
   */
  maxAttempts?: number;
}

/**
 * Classifies one Telegram post and extracts its fields.
 *
 * Never throws. A missing API key, a provider failure, a timeout or unusable
 * output all come back as `{ ok: false, reason }` so the caller can skip the
 * message and log a single line. A 429 additionally sets `rateLimited`, which is
 * how the queue tells "try again later" apart from "this will never work".
 */
export async function classifyJobPost(
  text: string,
  options: ClassifyOptions = {},
): Promise<ClassificationResult> {
  if (!isLlmConfigured()) {
    return { ok: false, reason: 'LLM not configured (GEMINI_API_KEY is not set)' };
  }

  const response = await generateStructured<RawClassification>({
    systemInstruction: SYSTEM_INSTRUCTION,
    prompt: buildPrompt(text),
    schema: CLASSIFICATION_SCHEMA,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
  });

  if (!response.ok) {
    return {
      ok: false,
      reason: response.reason,
      ...(response.rateLimited ? { rateLimited: true } : {}),
      ...(response.retryAfterMs !== undefined ? { retryAfterMs: response.retryAfterMs } : {}),
    };
  }

  return sanitizeClassification(response.data, text);
}
