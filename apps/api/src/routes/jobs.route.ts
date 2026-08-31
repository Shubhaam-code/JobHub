import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { requireProfile, type ProfileRequest } from '../middleware/require-profile.js';
import {
  activeJobClauses,
  activeJobFilter,
  JobModel,
  type Job,
  type JobQueryFilter,
} from '../models/job.model.js';
import { scoreJob } from '../recommendations/matching.js';
import { normalizeMessage } from '../telegram/normalize.js';
import { isPromotionalUrl } from '../telegram/text-safety.js';

type JobFilter = JobQueryFilter;

export const jobsRouter = Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * How many recent jobs a recommendation request scores.
 *
 * Scoring is cheap string work, so the whole pool is handled inline on request —
 * no queue, no cache, no precomputed scores. The bound exists so the cost stays
 * flat as the collection grows; older-than-this postings are rarely still open.
 */
const RECOMMENDATION_POOL_SIZE = 500;

/**
 * There is no stored `type` field — opportunity type is derived from the role
 * text, using the same rule the web client uses (`/intern/i`). Roles that do not
 * mention an internship (including a null role) count as full-time.
 */
const INTERN_ROLE_REGEX = /intern/i;
const INTERNSHIP_TYPE_VALUES = new Set(['internship', 'internships', 'intern']);
const FULL_TIME_TYPE_VALUES = new Set(['full-time', 'fulltime', 'full_time', 'job', 'jobs']);

/**
 * A job as the public API describes it: job data, and nothing about where it
 * came from.
 *
 * Every provenance field on the document is deliberately absent — `source`,
 * `telegramChannel`, `telegramChannelId`, `telegramMessageId`,
 * `telegramMessageUrl` and the raw `originalText`. Which channels feed the
 * product is internal information, readable only through `/api/admin/*`.
 *
 * Adding a field to this interface publishes it to every anonymous caller, so
 * anything Telegram-derived belongs on an admin route instead.
 */
export interface PublicJob {
  id: string;
  company: string | null;
  role: string | null;
  batch: string | null;
  applyUrl: string | null;
  location: string | null;
  employmentType: string | null;
  /** Post text with channel promotion, handles and chat links removed. */
  description: string;
  postedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MongoJobDoc extends Job {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cleaned text for display.
 *
 * Documents ingested through the queue already carry `cleanedText`, produced by
 * `normalizeMessage` — which is where promotion, bare @handles and chat links are
 * stripped. Rows stored before that field existed are normalized on read.
 *
 * When normalization leaves nothing, the result is empty rather than the raw
 * post: falling back to `originalText` would publish the unfiltered Telegram
 * message, which is exactly what this endpoint must not expose.
 */
function resolveDescription(doc: MongoJobDoc): string {
  const stored = doc.cleanedText?.trim();
  if (stored !== undefined && stored.length > 0) return stored;

  return normalizeMessage(doc.originalText ?? '').cleanedText;
}

/**
 * Drops an applyUrl that points at a chat or social page.
 *
 * The current pipeline already refuses those as apply links, but jobs stored by
 * the earlier one can carry a `t.me/<channel>` "apply" URL, which would name a
 * source channel on the card.
 */
function resolveApplyUrl(applyUrl: string | null | undefined): string | null {
  if (!applyUrl) return null;

  return isPromotionalUrl(applyUrl) ? null : applyUrl;
}

const toIso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

export function formatJob(doc: MongoJobDoc): PublicJob {
  return {
    id: doc._id.toString(),
    company: doc.company ?? null,
    role: doc.role ?? null,
    batch: doc.batch ?? null,
    applyUrl: resolveApplyUrl(doc.applyUrl),
    location: doc.location ?? null,
    employmentType: doc.employmentType ?? null,
    description: resolveDescription(doc),
    postedAt: toIso(doc.postedAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parsePositiveInteger(value: unknown, name: string, max?: number): number {
  if (value === undefined) {
    return name === 'page' ? DEFAULT_PAGE : DEFAULT_LIMIT;
  }

  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw badRequest(`Invalid ${name} parameter. Must be a positive integer.`);
  }

  const parsed = parseInt(value.trim(), 10);
  if (parsed < 1 || (max !== undefined && parsed > max)) {
    const rangeMsg = max !== undefined ? `between 1 and ${max}` : 'greater than 0';
    throw badRequest(`Invalid ${name} parameter. Must be ${rangeMsg}.`);
  }

  return parsed;
}

/**
 * GET /api/v1/jobs
 * Lists jobs with pagination, newest postedAt first.
 * Supports query parameters: page, limit, search, type, batch.
 *
 * Only listings that are still on show are returned — active, and inside their
 * 21-day window (`activeJobClauses`). An expired posting is not deleted, it is
 * simply not something this endpoint will hand out, so the count and the pages
 * both describe the live feed.
 *
 * There is deliberately no `channel` parameter: accepting one would let anyone
 * confirm or enumerate the source channels by observing which values return
 * results. Filtering by channel is an admin concern.
 */
jobsRouter.get('/', async (req: Request, res: Response) => {
  const page = parsePositiveInteger(req.query['page'], 'page');
  const limit = parsePositiveInteger(req.query['limit'], 'limit', MAX_LIMIT);

  // Expiry first: whatever the caller asks for is narrowed to the live feed.
  const andClauses: JobFilter[] = activeJobClauses();

  // Search filter (company or role)
  if (typeof req.query['search'] === 'string') {
    const searchTrimmed = req.query['search'].trim();
    if (searchTrimmed.length > 0) {
      const regex = new RegExp(escapeRegex(searchTrimmed), 'i');
      andClauses.push({
        $or: [{ company: regex }, { role: regex }],
      });
    }
  }

  // Batch filter
  if (typeof req.query['batch'] === 'string') {
    const batchTrimmed = req.query['batch'].trim();
    if (batchTrimmed.length > 0) {
      andClauses.push({
        batch: new RegExp(escapeRegex(batchTrimmed), 'i'),
      });
    }
  }

  // Type filter — internship vs full-time, derived from the role text.
  if (typeof req.query['type'] === 'string') {
    const typeTrimmed = req.query['type'].trim().toLowerCase();
    if (typeTrimmed.length > 0) {
      if (INTERNSHIP_TYPE_VALUES.has(typeTrimmed)) {
        andClauses.push({ role: INTERN_ROLE_REGEX });
      } else if (FULL_TIME_TYPE_VALUES.has(typeTrimmed)) {
        andClauses.push({ role: { $not: INTERN_ROLE_REGEX } });
      } else {
        throw badRequest('Invalid type parameter. Must be "internship" or "full-time".');
      }
    }
  }

  // Always at least the two expiry clauses, so the filter is always an $and.
  const filter: JobFilter = { $and: andClauses };

  const skip = (page - 1) * limit;

  const [docs, total] = await Promise.all([
    JobModel.find(filter)
      .sort({ postedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean<MongoJobDoc[]>(),
    JobModel.countDocuments(filter),
  ]);

  const totalPages = Math.ceil(total / limit);

  res.status(200).json({
    data: docs.map(formatJob),
    pagination: {
      page,
      limit,
      total,
      totalPages,
    },
  });
});

/**
 * GET /api/v1/jobs/recommended
 *
 * Jobs ranked against the caller's own candidate profile.
 *
 * Declared before `/:id` so "recommended" is not treated as an object id.
 *
 * Scoring is deterministic and in-process (see `recommendations/matching.ts`):
 * no LLM call, no embedding, no precomputed table. That is what lets this run on
 * request and lets a job ingested a minute ago be recommendable immediately —
 * it is already in the same `jobs` collection everything else reads.
 */
jobsRouter.get('/recommended', requireProfile, async (req: Request, res: Response) => {
  const profile = (req as ProfileRequest).candidateProfile;
  const limit = parsePositiveInteger(req.query['limit'], 'limit', MAX_LIMIT);

  const hasPreferences =
    (profile.skills?.length ?? 0) > 0 ||
    (profile.preferredRoles?.length ?? 0) > 0 ||
    (profile.preferredLocations?.length ?? 0) > 0 ||
    (profile.preferredJobTypes?.length ?? 0) > 0;

  // An empty profile has nothing to match on. Returning early keeps the request
  // cheap and, more importantly, guarantees no job is presented as a "match" on
  // the strength of no evidence at all.
  if (!hasPreferences) {
    res.status(200).json({
      data: [],
      meta: { minScore: env.RECOMMENDATION_MIN_SCORE, considered: 0, hasPreferences: false },
    });
    return;
  }

  const docs = await JobModel.find(activeJobFilter())
    .sort({ postedAt: -1, _id: -1 })
    .limit(RECOMMENDATION_POOL_SIZE)
    .lean<MongoJobDoc[]>();

  const recommendations = docs
    .map((doc) => ({ doc, match: scoreJob(profile, doc) }))
    .filter((entry) => entry.match.matchScore >= env.RECOMMENDATION_MIN_SCORE)
    .sort((a, b) => {
      if (b.match.matchScore !== a.match.matchScore) {
        return b.match.matchScore - a.match.matchScore;
      }
      // Same score: newer post first, matching the rest of the API's ordering.
      return new Date(b.doc.postedAt).getTime() - new Date(a.doc.postedAt).getTime();
    })
    .slice(0, limit)
    .map(({ doc, match }) => ({
      // The real stored job, formatted exactly as every other endpoint formats
      // it — so `applyUrl` is the ingested link, untouched.
      job: formatJob(doc),
      matchScore: match.matchScore,
      matchedSkills: match.matchedSkills,
      reasons: match.reasons,
      gaps: match.gaps,
    }));

  res.status(200).json({
    data: recommendations,
    meta: {
      minScore: env.RECOMMENDATION_MIN_SCORE,
      considered: docs.length,
      hasPreferences: true,
    },
  });
});

/**
 * GET /api/v1/jobs/:id
 * Retrieves a single job by MongoDB ID.
 *
 * The expiry clauses are part of the lookup, so a listing that has passed its
 * 21-day window (or that a source has closed) answers 404 here just as it is
 * absent from the list — a stale link cannot reopen a hidden posting.
 */
jobsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!id || !mongoose.isValidObjectId(id)) {
    throw badRequest('Invalid job ID format');
  }

  const doc = await JobModel.findOne({
    _id: id,
    ...activeJobFilter(),
  }).lean<MongoJobDoc | null>();

  if (!doc) {
    throw notFound('Job not found');
  }

  res.status(200).json({
    data: formatJob(doc),
  });
});
