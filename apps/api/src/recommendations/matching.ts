/**
 * Deterministic job matching.
 *
 * No LLM runs here. Scoring is pure arithmetic over text the ingestion pipeline
 * already stored, so a request that scores a few hundred jobs costs no API calls
 * and always produces the same answer for the same input — which is also what
 * makes the explanations trustworthy: they are read off the same comparisons
 * that produced the number, not written by a model.
 */

import type { CandidateProfile } from '../models/candidate-profile.model.js';
import { extractSkills, normalizeSkillList } from './skill-dictionary.js';

/**
 * Relative importance of each dimension, out of 100.
 *
 * This object is the single place to retune matching — change a number here and
 * nothing else needs to move. Dimensions that cannot be judged for a given
 * job/candidate pair are dropped and their weight is shared out across the rest
 * (see `scoreJob`), so these are ratios rather than fixed point budgets.
 */
export const MATCH_WEIGHTS = {
  skills: 50,
  role: 20,
  location: 15,
  jobType: 10,
  experience: 5,
} as const;

export type MatchDimension = keyof typeof MATCH_WEIGHTS;

/** The job fields matching reads. Kept narrow so tests need no full document. */
export interface MatchableJob {
  role?: string | null;
  company?: string | null;
  location?: string | null;
  employmentType?: string | null;
  cleanedText?: string | null;
  originalText?: string | null;
}

export interface MatchResult {
  /** 0–100, rounded. */
  matchScore: number;
  /** Candidate skills the job actually asks for. */
  matchedSkills: string[];
  /** Human-readable reasons, one per dimension that matched. */
  reasons: string[];
  /** Skills the job asks for that the candidate does not list. */
  gaps: string[];
}

/** Lowercase, collapse punctuation and whitespace to single spaces. */
export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/ {2,}/g, ' ');
}

/**
 * True when `term` appears in `haystack` as a whole term rather than as part of
 * a longer word, so "Go" does not match "Google" and "C" does not match "CSS".
 */
export function containsTerm(haystack: string, term: string): boolean {
  const normalizedTerm = normalizeText(term);
  if (normalizedTerm.length === 0) return false;

  const padded = ` ${normalizeText(haystack)} `;
  return padded.includes(` ${normalizedTerm} `);
}

/**
 * Words that appear in almost every job title. A shared "Developer" says nothing
 * about fit, so role comparison ignores them and looks at what is left —
 * otherwise "Backend Developer" would half-match "iOS Developer".
 */
const GENERIC_ROLE_WORDS = new Set([
  'developer',
  'dev',
  'engineer',
  'engineering',
  'intern',
  'internship',
  'trainee',
  'fresher',
  'associate',
  'executive',
  'specialist',
  'manager',
  'officer',
  'consultant',
  'analyst',
  'assistant',
  'junior',
  'senior',
  'jr',
  'sr',
  'sde',
  'swe',
  'i',
  'ii',
  'role',
  'position',
  'opening',
  'profile',
  'and',
  'or',
  'the',
  'of',
  'for',
  'in',
  'at',
]);

/** The words in a role title that actually distinguish it from other roles. */
function distinctiveRoleWords(role: string): string[] {
  return normalizeText(role)
    .split(' ')
    .filter((word) => word.length > 1 && !GENERIC_ROLE_WORDS.has(word));
}

/**
 * Cities and work arrangements that are the same place under different names.
 * Each row is one location; any spelling in it matches any other.
 */
const LOCATION_ALIASES: readonly (readonly string[])[] = [
  ['remote', 'work from home', 'wfh', 'anywhere', 'virtual'],
  ['bengaluru', 'bangalore', 'blr'],
  ['delhi', 'new delhi', 'ncr', 'delhi ncr', 'gurgaon', 'gurugram', 'noida'],
  ['mumbai', 'bombay', 'navi mumbai'],
  ['hyderabad', 'hyd', 'secunderabad'],
  ['chennai', 'madras'],
  ['kolkata', 'calcutta'],
  ['pune', 'pimpri'],
  ['ahmedabad', 'gandhinagar'],
  ['hybrid'],
];

/** Every spelling of the location `value` names, including `value` itself. */
function locationSpellings(value: string): string[] {
  const normalized = normalizeText(value);
  const row = LOCATION_ALIASES.find((aliases) =>
    aliases.some((alias) => normalized === alias || normalized.includes(alias)),
  );

  return row === undefined ? [normalized] : [...row];
}

/**
 * The employment types the ingestion pipeline stores. Same closed set the job
 * classifier uses, so a candidate's preference and a job's type are comparable
 * without translation.
 */
export const JOB_TYPES = [
  'internship',
  'full-time',
  'part-time',
  'contract',
  'apprenticeship',
  'training',
] as const;

/** The employment types the ingestion pipeline stores, plus common spellings. */
const JOB_TYPE_ALIASES: Record<string, readonly string[]> = {
  internship: ['internship', 'intern', 'interns', 'summer intern', 'industrial training'],
  'full-time': ['full time', 'fulltime', 'ft', 'permanent', 'full time employment'],
  'part-time': ['part time', 'parttime', 'pt'],
  contract: ['contract', 'contractual', 'freelance', 'consultant', 'temporary'],
  apprenticeship: ['apprenticeship', 'apprentice'],
  training: ['training', 'trainee'],
};

/** Maps any spelling of an employment type onto its canonical form. */
export function normalizeJobType(value: string): string | null {
  const normalized = normalizeText(value);
  if (normalized.length === 0) return null;

  for (const [canonical, aliases] of Object.entries(JOB_TYPE_ALIASES)) {
    if (normalized === normalizeText(canonical)) return canonical;
    if (aliases.some((alias) => normalized === alias)) return canonical;
  }

  // Fall back to a containment check so "6 month internship" still resolves.
  for (const [canonical, aliases] of Object.entries(JOB_TYPE_ALIASES)) {
    if (aliases.some((alias) => containsTerm(normalized, alias))) return canonical;
  }

  return null;
}

/** Title Case for display, so "full-time" reads as "Full-Time" in a reason. */
function titleCase(value: string): string {
  return value.replace(/(^|[\s-])([a-z])/g, (_match, prefix: string, letter: string) => {
    return prefix + letter.toUpperCase();
  });
}

/**
 * Years of experience a post asks for, or null when it does not say.
 *
 * Reads the lower bound: "2-4 years" and "2+ years" both mean a candidate with
 * 2 years qualifies. "Fresher" and "no experience required" mean 0.
 */
export function parseRequiredExperience(text: string): number | null {
  const normalized = normalizeText(text);

  if (/\b(fresher|freshers|no experience|without experience|0 experience)\b/.test(normalized)) {
    return 0;
  }

  const range = /\b(\d{1,2})\s*(?:\+|to|-)?\s*(?:\d{1,2})?\s*(?:\+)?\s*(?:years?|yrs?)\b/.exec(
    normalized,
  );
  const lower = range?.[1];
  if (lower === undefined) return null;

  const years = Number(lower);
  // Beyond this it is not an experience requirement (a year, a stipend, a count).
  return years >= 0 && years <= 20 ? years : null;
}

/** All text worth searching for a job's requirements, richest field first. */
function jobSearchText(job: MatchableJob): string {
  return [job.role, job.company, job.location, job.employmentType, job.cleanedText ?? job.originalText]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n');
}

/** One dimension's outcome: absent dimensions carry no weight and no reason. */
interface DimensionScore {
  /** 0–1, or null when this dimension cannot be judged for this pair. */
  ratio: number | null;
  reason?: string;
}

function scoreSkills(
  candidateSkills: string[],
  text: string,
): DimensionScore & { matchedSkills: string[]; gaps: string[] } {
  if (candidateSkills.length === 0) {
    return { ratio: null, matchedSkills: [], gaps: [] };
  }

  // What the job asks for: dictionary skills named in the post, plus any of the
  // candidate's own (possibly niche) skills the post names. Scoring against the
  // job's requirements rather than the candidate's full skill list is what keeps
  // a well-matched candidate from being punished for knowing extra things.
  const dictionarySkills = extractSkills(text);
  const extraCandidateSkills = candidateSkills.filter(
    (skill) =>
      !dictionarySkills.some((found) => found.toLowerCase() === skill.toLowerCase()) &&
      containsTerm(text, skill),
  );
  const requiredSkills = [...dictionarySkills, ...extraCandidateSkills];

  if (requiredSkills.length === 0) {
    return { ratio: null, matchedSkills: [], gaps: [] };
  }

  const candidateLower = new Set(candidateSkills.map((skill) => skill.toLowerCase()));
  const matchedSkills = requiredSkills.filter((skill) => candidateLower.has(skill.toLowerCase()));
  const gaps = requiredSkills.filter((skill) => !candidateLower.has(skill.toLowerCase()));

  const reason =
    matchedSkills.length === 0
      ? undefined
      : `${formatList(matchedSkills)} ${matchedSkills.length === 1 ? 'matches' : 'match'} your skills`;

  return {
    ratio: matchedSkills.length / requiredSkills.length,
    ...(reason === undefined ? {} : { reason }),
    matchedSkills,
    gaps,
  };
}

/** "A", "A and B", "A, B and C" — capped so a reason stays one line. */
function formatList(values: string[], limit = 4): string {
  const shown = values.slice(0, limit);
  const remainder = values.length - shown.length;

  const joined =
    shown.length <= 1
      ? (shown[0] ?? '')
      : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1] as string}`;

  return remainder > 0 ? `${joined} +${remainder} more` : joined;
}

function scoreRole(preferredRoles: string[], job: MatchableJob, text: string): DimensionScore {
  if (preferredRoles.length === 0) return { ratio: null };

  const jobRole = job.role ?? '';
  // Prefer the extracted role field; fall back to the post text so a job whose
  // role failed extraction can still match.
  const haystack = jobRole.length > 0 ? jobRole : text;

  let best = 0;
  let bestRole = '';

  for (const preferred of preferredRoles) {
    const distinctive = distinctiveRoleWords(preferred);

    // A title made only of generic words ("Software Engineer") can still match
    // as a whole phrase, but must not match on "engineer" alone.
    const ratio =
      distinctive.length === 0
        ? containsTerm(haystack, preferred)
          ? 1
          : 0
        : distinctive.filter((word) => containsTerm(haystack, word)).length / distinctive.length;

    if (ratio > best) {
      best = ratio;
      bestRole = preferred;
    }
  }

  return {
    ratio: best,
    ...(best > 0 ? { reason: `${titleCase(bestRole)} matches your preferred role` } : {}),
  };
}

function scoreLocation(preferredLocations: string[], job: MatchableJob): DimensionScore {
  if (preferredLocations.length === 0) return { ratio: null };

  const jobLocation = job.location ?? '';
  if (jobLocation.trim().length === 0) return { ratio: null };

  const jobSpellings = locationSpellings(jobLocation);

  for (const preferred of preferredLocations) {
    const preferredSpellings = locationSpellings(preferred);
    const hit = preferredSpellings.some((spelling) =>
      jobSpellings.some(
        (jobSpelling) => jobSpelling.includes(spelling) || spelling.includes(jobSpelling),
      ),
    );

    if (hit) {
      return {
        ratio: 1,
        reason: `${titleCase(jobLocation.trim())} matches your preferred location`,
      };
    }
  }

  return { ratio: 0 };
}

function scoreJobType(preferredJobTypes: string[], job: MatchableJob): DimensionScore {
  if (preferredJobTypes.length === 0) return { ratio: null };

  const jobType = job.employmentType === null ? null : normalizeJobType(job.employmentType ?? '');
  if (jobType === null) return { ratio: null };

  const preferred = preferredJobTypes
    .map((value) => normalizeJobType(value))
    .filter((value): value is string => value !== null);

  if (preferred.length === 0) return { ratio: null };

  return preferred.includes(jobType)
    ? { ratio: 1, reason: `${titleCase(jobType)} matches your preferred job type` }
    : { ratio: 0 };
}

function scoreExperience(experienceYears: number | null, text: string): DimensionScore {
  if (experienceYears === null) return { ratio: null };

  const required = parseRequiredExperience(text);
  if (required === null) return { ratio: null };

  if (experienceYears >= required) {
    const label = required === 0 ? 'open to freshers' : `asks for ${required}+ years`;
    return { ratio: 1, reason: `Your experience fits — this role is ${label}` };
  }

  // Close enough is partial credit: 1 year short of 2 is not the same as 5 short.
  const shortfall = required - experienceYears;
  return { ratio: shortfall <= 1 ? 0.5 : 0 };
}

/**
 * Scores one job against one profile.
 *
 * Weights are shared out across only the dimensions that can be judged: a job
 * post with no location, or a candidate who set no location preference, should
 * not cost the job 15 points it never had a chance to earn.
 */
export function scoreJob(
  profile: Pick<
    CandidateProfile,
    'skills' | 'preferredRoles' | 'preferredLocations' | 'preferredJobTypes' | 'experienceYears'
  >,
  job: MatchableJob,
): MatchResult {
  const text = jobSearchText(job);
  const candidateSkills = normalizeSkillList(profile.skills ?? []);

  const skills = scoreSkills(candidateSkills, text);
  const dimensions: Record<MatchDimension, DimensionScore> = {
    skills,
    role: scoreRole(profile.preferredRoles ?? [], job, text),
    location: scoreLocation(profile.preferredLocations ?? [], job),
    jobType: scoreJobType(profile.preferredJobTypes ?? [], job),
    experience: scoreExperience(profile.experienceYears ?? null, text),
  };

  let earned = 0;
  let available = 0;
  const reasons: string[] = [];

  for (const key of Object.keys(MATCH_WEIGHTS) as MatchDimension[]) {
    const dimension = dimensions[key];
    if (dimension.ratio === null) continue;

    const weight = MATCH_WEIGHTS[key];
    available += weight;
    earned += weight * dimension.ratio;

    if (dimension.reason !== undefined) reasons.push(dimension.reason);
  }

  // Nothing comparable — an empty profile scores 0 rather than a flattering
  // default, so no fabricated recommendation can reach the user.
  const matchScore = available === 0 ? 0 : Math.round((earned / available) * 100);

  return {
    matchScore,
    matchedSkills: skills.matchedSkills,
    reasons,
    gaps: skills.gaps.slice(0, 5),
  };
}
