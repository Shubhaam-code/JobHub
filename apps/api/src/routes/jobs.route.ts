import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';

import { env } from '../config/env.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { JobModel, type Job } from '../models/job.model.js';

type JobFilter = Record<string, unknown>;

export const jobsRouter = Router();

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * There is no stored `type` field — opportunity type is derived from the role
 * text, using the same rule the web client uses (`/intern/i`). Roles that do not
 * mention an internship (including a null role) count as full-time.
 */
const INTERN_ROLE_REGEX = /intern/i;
const INTERNSHIP_TYPE_VALUES = new Set(['internship', 'internships', 'intern']);
const FULL_TIME_TYPE_VALUES = new Set(['full-time', 'fulltime', 'full_time', 'job', 'jobs']);

export interface PublicJob {
  id: string;
  company: string | null;
  role: string | null;
  batch: string | null;
  applyUrl: string | null;
  location: string | null;
  employmentType: string | null;
  source: string;
  telegramChannel: string;
  telegramMessageId: number;
  telegramMessageUrl: string | null;
  originalText: string;
  postedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MongoJobDoc extends Job {
  _id: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export function formatJob(doc: MongoJobDoc): PublicJob {
  return {
    id: doc._id.toString(),
    company: doc.company ?? null,
    role: doc.role ?? null,
    batch: doc.batch ?? null,
    applyUrl: doc.applyUrl ?? null,
    location: doc.location ?? null,
    employmentType: doc.employmentType ?? null,
    source: doc.source,
    telegramChannel: doc.telegramChannel,
    telegramMessageId: doc.telegramMessageId,
    telegramMessageUrl: doc.telegramMessageUrl ?? null,
    originalText: doc.originalText,
    postedAt:
      doc.postedAt instanceof Date
        ? doc.postedAt.toISOString()
        : new Date(doc.postedAt).toISOString(),
    createdAt:
      doc.createdAt instanceof Date
        ? doc.createdAt.toISOString()
        : new Date(doc.createdAt).toISOString(),
    updatedAt:
      doc.updatedAt instanceof Date
        ? doc.updatedAt.toISOString()
        : new Date(doc.updatedAt).toISOString(),
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
 * Supports query parameters: page, limit, search, type, batch, channel.
 */
jobsRouter.get('/', async (req: Request, res: Response) => {
  const page = parsePositiveInteger(req.query['page'], 'page');
  const limit = parsePositiveInteger(req.query['limit'], 'limit', MAX_LIMIT);

  const filter: JobFilter = {};
  const andClauses: JobFilter[] = [];

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

  // Channel filter — exact source channel, tolerating a leading "@".
  if (typeof req.query['channel'] === 'string') {
    const channelTrimmed = req.query['channel'].trim().replace(/^@/, '');
    if (channelTrimmed.length > 0) {
      andClauses.push({
        telegramChannel: new RegExp(`^${escapeRegex(channelTrimmed)}$`, 'i'),
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

  if (andClauses.length === 1) {
    Object.assign(filter, andClauses[0]);
  } else if (andClauses.length > 1) {
    filter.$and = andClauses;
  }

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
 * Merges the configured channel list with the channels that actually have
 * stored jobs. Configured order comes first (so the client's source filter
 * mirrors TELEGRAM_CHANNELS), then any stored-only channel A→Z — a channel that
 * was ingested before being removed from the config stays filterable.
 *
 * Telegram usernames are case-insensitive, so entries are deduped
 * case-insensitively and the configured spelling wins.
 */
export function mergeChannelNames(configured: string[], stored: string[]): string[] {
  const seen = new Set<string>();
  const channels: string[] = [];

  const add = (name: string): void => {
    const username = name.trim().replace(/^@/, '');
    if (username.length === 0) return;

    const key = username.toLowerCase();
    if (seen.has(key)) return;

    seen.add(key);
    channels.push(username);
  };

  configured.forEach(add);
  [...stored].sort().forEach(add);

  return channels;
}

/**
 * GET /api/v1/jobs/channels
 * Lists every channel available as a source filter: the configured
 * TELEGRAM_CHANNELS (even the ones with 0 stored jobs yet) plus any channel
 * still present in MongoDB. Declared before `/:id` so it is not treated as an
 * object id.
 */
jobsRouter.get('/channels', async (_req: Request, res: Response) => {
  const stored = await JobModel.distinct('telegramChannel');

  res.status(200).json({
    data: mergeChannelNames(
      env.telegramChannels,
      stored.filter((channel): channel is string => typeof channel === 'string'),
    ),
  });
});

/**
 * GET /api/v1/jobs/:id
 * Retrieves a single job by MongoDB ID.
 */
jobsRouter.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  if (!id || !mongoose.isValidObjectId(id)) {
    throw badRequest('Invalid job ID format');
  }

  const doc = await JobModel.findById(id).lean<MongoJobDoc | null>();

  if (!doc) {
    throw notFound('Job not found');
  }

  res.status(200).json({
    data: formatJob(doc),
  });
});
