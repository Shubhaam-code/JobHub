import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';

import { badRequest, notFound } from '../lib/http-error.js';
import { isDatabaseConnected } from '../config/database.js';
import { JobModel, type JobQueryFilter } from '../models/job.model.js';
import {
  GITHUB_ACTIVE_WINDOW_DAYS,
  GITHUB_SOURCE,
  githubSourceCutoff,
} from '../github/sync.js';
import { formatJob, type MongoJobDoc } from './jobs.route.js';

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 24;
const MAX_LIMIT = 100;

export const globalInternshipsRouter = Router();

function parsePositiveInteger(value: unknown, name: string, max?: number): number {
  if (value === undefined) return name === 'page' ? DEFAULT_PAGE : DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    throw badRequest('Invalid ' + name + ' parameter. Must be a positive integer.');
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (parsed < 1 || (max !== undefined && parsed > max)) {
    const range = max === undefined ? 'greater than 0' : 'between 1 and ' + max;
    throw badRequest('Invalid ' + name + ' parameter. Must be ' + range + '.');
  }
  return parsed;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^()|[\]\\]/g, '\\$&').replace(/\$/g, '\\$');
}

/**
 * One end of a `postedAt` window, as an absolute instant.
 *
 * The client sends instants rather than a named window ("today", "yesterday")
 * because only the browser knows which timezone the reader is in — "today" has to
 * be resolved to real boundaries there. The server just applies the range.
 */
function parseInstant(value: unknown, name: string): Date | null {
  if (value === undefined) return null;

  const text = typeof value === 'string' ? value.trim() : '';
  const parsed = text.length > 0 ? new Date(text) : new Date(Number.NaN);

  if (Number.isNaN(parsed.getTime())) {
    throw badRequest('Invalid ' + name + ' parameter. Must be an ISO 8601 date or date-time.');
  }
  return parsed;
}

export function globalInternshipFilter(now: Date = new Date()): JobQueryFilter {
  return {
    $and: [
      { source: GITHUB_SOURCE },
      {
        $or: [
          { githubFeedActive: true },
          { githubFeedActive: null, status: 'active' },
          { githubFeedActive: null, status: null },
        ],
      },
      { postedAt: { $gte: githubSourceCutoff(now) } },
    ],
  };
}

/**
 * Public GitHub-backed internship feed. This endpoint is intentionally separate
 * from `/jobs`: its source, date window and pagination can evolve independently
 * without changing the existing Jobs flow.
 */
globalInternshipsRouter.get('/', async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  if (!isDatabaseConnected()) {
    res.status(200).json({
      data: [],
      pagination: { page: 1, limit: DEFAULT_LIMIT, total: 0, totalPages: 0 },
      meta: {
        source: 'github',
        activeWindowDays: GITHUB_ACTIVE_WINDOW_DAYS,
        degraded: true,
        message: 'Global internships are temporarily unavailable while the database reconnects.',
      },
    });
    return;
  }
  const page = parsePositiveInteger(req.query['page'], 'page');
  const limit = parsePositiveInteger(req.query['limit'], 'limit', MAX_LIMIT);
  const now = new Date();
  const cutoff = githubSourceCutoff(now);
  const clauses = [...(globalInternshipFilter(now).$and as JobQueryFilter[])];

  if (typeof req.query['search'] === 'string' && req.query['search'].trim()) {
    const regex = new RegExp(escapeRegex(req.query['search'].trim()), 'i');
    clauses.push({ $or: [{ company: regex }, { role: regex }] });
  }
  if (typeof req.query['location'] === 'string' && req.query['location'].trim()) {
    clauses.push({ location: new RegExp(escapeRegex(req.query['location'].trim()), 'i') });
  }

  /* Posted-date window. Both ends are optional, so "since yesterday" and "one
     specific day" are the same parameter pair. The lower bound is clamped to the
     feed's own 21-day cutoff: a caller asking for something older gets the window
     it is allowed to see rather than a silently empty page. */
  const postedFrom = parseInstant(req.query['postedFrom'], 'postedFrom');
  const postedTo = parseInstant(req.query['postedTo'], 'postedTo');

  if (postedFrom && postedTo && postedFrom.getTime() > postedTo.getTime()) {
    throw badRequest('Invalid date range. postedFrom must not be later than postedTo.');
  }

  const from = postedFrom && postedFrom.getTime() > cutoff.getTime() ? postedFrom : null;

  /* Only when a bound survives clamping. `{ postedAt: {} }` is not an empty
     condition in MongoDB — it matches documents whose `postedAt` is an empty
     document, i.e. none — so a fully clamped range would hide the whole feed. */
  if (from || postedTo) {
    clauses.push({
      postedAt: {
        ...(from ? { $gte: from } : {}),
        ...(postedTo ? { $lte: postedTo } : {}),
      },
    });
  }

  const filter: JobQueryFilter = { $and: clauses };
  const sortValue = typeof req.query['sort'] === 'string' ? req.query['sort'].trim() : '';
  if (sortValue !== '' && sortValue !== 'newest' && sortValue !== 'oldest') {
    throw badRequest('Invalid sort parameter. Must be "newest" or "oldest".');
  }
  const sortDirection = sortValue === 'oldest' ? 1 : -1;

  const [docs, total] = await Promise.all([
    JobModel.find(filter)
      .sort({ postedAt: sortDirection, _id: sortDirection })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<MongoJobDoc[]>(),
    JobModel.countDocuments(filter),
  ]);

  res.status(200).json({
    data: docs.map(formatJob),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    meta: {
      source: 'github',
      activeWindowDays: GITHUB_ACTIVE_WINDOW_DAYS,
      // The oldest date this feed will answer for, so a date picker can bound
      // itself to the window instead of offering days that return nothing.
      windowStart: cutoff.toISOString(),
      windowEnd: now.toISOString(),
    },
  });
});

globalInternshipsRouter.get('/:id', async (req: Request, res: Response) => {
  if (!req.params.id || !mongoose.isValidObjectId(req.params.id)) {
    throw badRequest('Invalid internship ID format');
  }
  if (!isDatabaseConnected()) {
    throw notFound('Internship not found');
  }

  const doc = await JobModel.findOne({
    _id: req.params.id,
    ...globalInternshipFilter(),
  }).lean<MongoJobDoc | null>();

  if (!doc) throw notFound('Internship not found');
  res.status(200).json({ data: formatJob(doc) });
});
