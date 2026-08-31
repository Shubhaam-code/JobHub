/**
 * Channel registry: the management and monitoring layer around ingestion.
 *
 * Deliberately thin. It owns exactly two things the ingestion pipeline does not:
 *
 *  1. **Active/Paused state**, persisted in the existing `channels` collection so
 *     it survives restarts and is never re-derived from `TELEGRAM_CHANNELS`.
 *  2. **Reporting**, computed on read from the collections that already exist —
 *     `ingest_queue` for message-level outcomes and `jobs` for stored jobs.
 *
 * Nothing here counts anything itself. Deriving statistics instead of
 * incrementing counters means the dashboard is correct for messages ingested
 * before this layer existed, cannot drift from reality, and adds no write to the
 * per-message hot path.
 *
 * The channel list is never hardcoded: it is the union of `TELEGRAM_CHANNELS`,
 * the registry, and whatever channels appear in stored data.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { ChannelModel } from '../models/channel.model.js';
import { IngestQueueModel } from '../models/ingest-queue.model.js';
import { JobModel } from '../models/job.model.js';

export const CHANNEL_STATUSES = ['active', 'paused'] as const;

export type ChannelStatus = (typeof CHANNEL_STATUSES)[number];

/** Normalizes a channel username to the registry's lookup key. */
function toKey(username: string): string {
  return username.trim().replace(/^@/, '').toLowerCase();
}

/* ── Configuration reconciliation ──────────────────────────────────────────── */

/**
 * Makes sure every configured channel has a registry document.
 *
 * `isActive` and `pausedAt` are set **only on insert**. That is the whole reason
 * an admin's pause survives a deploy: a restart re-runs this function, and it
 * must never quietly re-enable a channel someone deliberately switched off.
 */
export async function ensureConfiguredChannels(
  usernames: string[] = env.telegramChannels,
): Promise<number> {
  let touched = 0;

  for (const username of usernames) {
    const usernameKey = toKey(username);
    if (usernameKey.length === 0) continue;

    try {
      await ChannelModel.updateOne(
        { usernameKey },
        {
          // Telegram's own casing for display; the key stays lowercase.
          $set: { username: username.trim().replace(/^@/, '') },
          $setOnInsert: { isActive: true, pausedAt: null },
        },
        { upsert: true },
      ).exec();
      touched += 1;
    } catch (error: unknown) {
      logger.warn(`[channels] Could not register @${username} in the registry`, error);
    }
  }

  invalidateChannelStatusCache();

  return touched;
}

/** Records the title and numeric id Telegram reports once a channel resolves. */
export async function registerResolvedChannel(input: {
  username: string;
  title?: string | null;
  telegramId?: string | null;
}): Promise<void> {
  const usernameKey = toKey(input.username);
  if (usernameKey.length === 0) return;

  const update: Record<string, unknown> = {
    username: input.username.trim().replace(/^@/, ''),
  };
  if (input.title) update['title'] = input.title;
  if (input.telegramId) update['telegramId'] = input.telegramId;

  try {
    await ChannelModel.updateOne(
      { usernameKey },
      { $set: update, $setOnInsert: { isActive: true, pausedAt: null } },
      { upsert: true },
    ).exec();
  } catch (error: unknown) {
    logger.warn(`[channels] Could not update @${input.username} metadata`, error);
  }
}

/**
 * Notes that a message from this channel just went through the pipeline.
 *
 * `$max` on the message id so an out-of-order backfill cannot walk the high-water
 * mark backwards. Failures are swallowed: reporting must never be able to break
 * ingestion.
 */
export async function recordChannelActivity(input: {
  username: string;
  messageId: number;
}): Promise<void> {
  const usernameKey = toKey(input.username);
  if (usernameKey.length === 0) return;

  try {
    await ChannelModel.updateOne(
      { usernameKey },
      {
        $max: { lastMessageId: input.messageId },
        $set: { lastSyncedAt: new Date() },
      },
    ).exec();
  } catch (error: unknown) {
    logger.debug(`[channels] Could not record activity for @${input.username}: ${String(error)}`);
  }
}

/* ── Pause / resume ────────────────────────────────────────────────────────── */

const STATUS_CACHE_TTL_MS = 5_000;

let statusCache: { loadedAt: number; enabled: Map<string, boolean> } | null = null;

/** Drops the cached statuses so the next check re-reads the registry. */
export function invalidateChannelStatusCache(): void {
  statusCache = null;
}

async function loadStatusMap(): Promise<Map<string, boolean>> {
  const now = Date.now();
  if (statusCache !== null && now - statusCache.loadedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.enabled;
  }

  const docs = await ChannelModel.find({}, { usernameKey: 1, isActive: 1 }).lean<
    { usernameKey: string; isActive: boolean }[]
  >();

  const enabled = new Map<string, boolean>();
  for (const doc of docs) enabled.set(doc.usernameKey, doc.isActive !== false);

  statusCache = { loadedAt: now, enabled };

  return enabled;
}

/**
 * Whether ingestion should accept messages from this channel.
 *
 * Checked once per message, so it is cached for a few seconds — a pause takes
 * effect within the TTL, and the admin route invalidates the cache immediately
 * anyway.
 *
 * Fails **open**, both for an unknown channel and for a registry error. A false
 * "paused" would silently drop messages that are never re-delivered; wrongly
 * ingesting a message during a database blip is the recoverable direction.
 */
export async function isChannelIngestionEnabled(username: string): Promise<boolean> {
  try {
    const enabled = await loadStatusMap();

    return enabled.get(toKey(username)) ?? true;
  } catch (error: unknown) {
    logger.warn(`[channels] Status check failed for @${username} — allowing ingestion`, error);

    return true;
  }
}

/**
 * Flips a channel between active and paused.
 *
 * Only ever writes `isActive`/`pausedAt`. No job, queued message or statistic is
 * touched, so resuming a channel restores it exactly as it was.
 */
export async function setChannelStatus(
  id: string,
  status: ChannelStatus,
): Promise<ChannelReport | null> {
  const updated = await ChannelModel.findByIdAndUpdate(
    id,
    {
      $set: {
        isActive: status === 'active',
        pausedAt: status === 'paused' ? new Date() : null,
      },
    },
    { new: true },
  ).lean<RegistryDoc | null>();

  // A pause has to bite now, not when the cache happens to expire.
  invalidateChannelStatusCache();

  if (updated === null) return null;

  const [reports] = await buildReports([updated]);

  return reports ?? null;
}

/* ── Reporting ─────────────────────────────────────────────────────────────── */

interface RegistryDoc {
  _id: unknown;
  username: string;
  usernameKey: string;
  title?: string | null;
  telegramId?: string | null;
  isActive: boolean;
  pausedAt?: Date | null;
  lastMessageId?: number | null;
  lastSyncedAt?: Date | null;
}

/** One row of the admin dashboard. */
export interface ChannelReport {
  /** Registry document id — the handle for PATCH /api/admin/channels/:id. */
  id: string | null;
  /** Telegram's title when known, else "@username". */
  name: string;
  username: string;
  telegramId: string | null;
  status: ChannelStatus;
  /** True while the username is present in TELEGRAM_CHANNELS. */
  configured: boolean;
  /** Messages taken from Telegram and queued. */
  messagesReceived: number;
  /** Queued messages that produced a job. */
  jobsExtracted: number;
  /** Queued messages the worker finished classifying, job or not. */
  jobsProcessed: number;
  /** Still queued: pending, in flight, or waiting to retry. */
  messagesPending: number;
  /** Dead-lettered after exhausting retries. */
  messagesFailed: number;
  /** Live count from the jobs collection. */
  jobsInDatabase: number;
  lastMessageAt: string | null;
  lastSyncAt: string | null;
  pausedAt: string | null;
}

interface QueueStatsRow {
  _id: string;
  messagesReceived: number;
  jobsExtracted: number;
  jobsProcessed: number;
  messagesPending: number;
  messagesFailed: number;
  lastMessageAt: Date | null;
}

/**
 * Per-channel message outcomes, grouped case-insensitively because the same
 * channel can appear under different casings across ingestion paths.
 */
async function loadQueueStats(): Promise<Map<string, QueueStatsRow>> {
  const rows = await IngestQueueModel.aggregate<QueueStatsRow>([
    {
      $group: {
        _id: { $toLower: '$telegramChannel' },
        messagesReceived: { $sum: 1 },
        jobsExtracted: { $sum: { $cond: [{ $ne: ['$jobId', null] }, 1, 0] } },
        jobsProcessed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
        messagesPending: {
          $sum: {
            $cond: [{ $in: ['$status', ['pending', 'processing', 'retry_wait']] }, 1, 0],
          },
        },
        messagesFailed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        lastMessageAt: { $max: '$postedAt' },
      },
    },
  ]).exec();

  return new Map(rows.map((row) => [row._id, row]));
}

/** Live job count per channel, so the dashboard never reports a stale total. */
async function loadJobCounts(): Promise<Map<string, number>> {
  const rows = await JobModel.aggregate<{ _id: string; count: number }>([
    { $group: { _id: { $toLower: '$telegramChannel' }, count: { $sum: 1 } } },
  ]).exec();

  return new Map(rows.map((row) => [row._id, row.count]));
}

const toIso = (value: Date | null | undefined): string | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;

async function buildReports(docs: RegistryDoc[]): Promise<ChannelReport[]> {
  const [queueStats, jobCounts] = await Promise.all([loadQueueStats(), loadJobCounts()]);
  const configured = new Set(env.telegramChannels.map(toKey));

  return docs.map((doc) => {
    const key = doc.usernameKey;
    const stats = queueStats.get(key);

    return {
      id: doc._id == null ? null : String(doc._id),
      name: doc.title?.trim() || `@${doc.username}`,
      username: doc.username,
      telegramId: doc.telegramId ?? null,
      status: doc.isActive === false ? 'paused' : 'active',
      configured: configured.has(key),
      messagesReceived: stats?.messagesReceived ?? 0,
      jobsExtracted: stats?.jobsExtracted ?? 0,
      jobsProcessed: stats?.jobsProcessed ?? 0,
      messagesPending: stats?.messagesPending ?? 0,
      messagesFailed: stats?.messagesFailed ?? 0,
      jobsInDatabase: jobCounts.get(key) ?? 0,
      lastMessageAt: toIso(stats?.lastMessageAt ?? null),
      lastSyncAt: toIso(doc.lastSyncedAt),
      pausedAt: toIso(doc.pausedAt),
    } satisfies ChannelReport;
  });
}

/**
 * Every channel the system knows about, with its statistics.
 *
 * The list is the union of three sources, so nothing is hidden and nothing is
 * hardcoded: registry documents, `TELEGRAM_CHANNELS` (a channel added to the env
 * but not yet seen), and channels present only in stored data (removed from the
 * env but still holding history). Configured channels sort first, then the rest
 * A→Z, matching the order the operator wrote them in.
 */
export async function listChannelsWithStats(): Promise<ChannelReport[]> {
  const docs = await ChannelModel.find().lean<RegistryDoc[]>();
  const known = new Set(docs.map((doc) => doc.usernameKey));

  const [queuedChannels, storedChannels] = await Promise.all([
    IngestQueueModel.distinct('telegramChannel'),
    JobModel.distinct('telegramChannel'),
  ]);

  const orphans = mergeChannelNames(
    env.telegramChannels,
    [...queuedChannels, ...storedChannels].filter(
      (name): name is string => typeof name === 'string',
    ),
  ).filter((name) => !known.has(toKey(name)));

  // Synthesized rows for channels with no registry document: configured but not
  // yet seeded, or dropped from the env while keeping their history. They report
  // statistics and are visibly not paused-able (no id) — there is no registry row
  // to flip, and for a removed channel there is nothing running to pause.
  const synthesized: RegistryDoc[] = orphans.map((username) => ({
    _id: null,
    username,
    usernameKey: toKey(username),
    isActive: true,
  }));

  const reports = await buildReports([...docs, ...synthesized]);
  const order = new Map(env.telegramChannels.map((name, index) => [toKey(name), index]));

  return reports.sort((a, b) => {
    const rankA = order.get(toKey(a.username)) ?? Number.MAX_SAFE_INTEGER;
    const rankB = order.get(toKey(b.username)) ?? Number.MAX_SAFE_INTEGER;

    return rankA !== rankB ? rankA - rankB : a.username.localeCompare(b.username);
  });
}

/**
 * Merges the configured channel list with channels that appear in stored data.
 * Configured order comes first, then any stored-only channel A→Z.
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
