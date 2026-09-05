/**
 * Admin API — Telegram channel management and monitoring.
 *
 * `requireAdmin` is applied to the router itself, before any route is declared,
 * so protection is structural: a new endpoint added below is authenticated and
 * role-checked whether or not its author remembers to. This is the real boundary
 * — the web app hiding `/admin` is only cosmetic.
 *
 * These are the only endpoints allowed to describe Telegram internals: channel
 * names, usernames, numeric ids and message counts. The public API never does.
 */

import { Router, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';

import { env } from '../config/env.js';
import { badRequest, notFound } from '../lib/http-error.js';
import { requireAdmin } from '../middleware/require-auth.js';
import { getQueueCounts } from '../queue/ingest-queue.js';
import { getDiscoveryQueueCounts } from '../apply-discovery/queue.js';
import {
  CHANNEL_STATUSES,
  listChannelsWithStats,
  setChannelStatus,
  type ChannelReport,
} from '../telegram/channel-registry.js';

export const adminRouter = Router();

// Every route below this line requires an authenticated ADMIN: 401 without a
// valid token, 403 for a normal USER.
adminRouter.use(requireAdmin);

/**
 * GET /api/admin/channels
 * Every channel the system knows about, with its ingestion statistics.
 *
 * The list is derived from the registry, TELEGRAM_CHANNELS and stored data — it
 * is never a hardcoded array.
 */
adminRouter.get('/channels', async (_req: Request, res: Response) => {
  const channels = await listChannelsWithStats();

  res.status(200).json({ data: channels });
});

const latest = (values: (string | null)[]): string | null =>
  values
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;

const sumBy = (channels: ChannelReport[], pick: (channel: ChannelReport) => number): number =>
  channels.reduce((total, channel) => total + pick(channel), 0);

/**
 * GET /api/admin/stats
 * Fleet-wide totals, plus whether ingestion is actually able to run.
 *
 * Totals are summed from the same per-channel report the table uses, so the two
 * views can never disagree.
 */
adminRouter.get('/stats', async (_req: Request, res: Response) => {
  const [channels, queue, applyDiscovery] = await Promise.all([
    listChannelsWithStats(),
    getQueueCounts(),
    getDiscoveryQueueCounts(),
  ]);

  res.status(200).json({
    data: {
      channels: {
        total: channels.length,
        active: channels.filter((channel) => channel.status === 'active').length,
        paused: channels.filter((channel) => channel.status === 'paused').length,
        configured: channels.filter((channel) => channel.configured).length,
      },
      messages: {
        received: sumBy(channels, (channel) => channel.messagesReceived),
        processed: sumBy(channels, (channel) => channel.jobsProcessed),
        pending: sumBy(channels, (channel) => channel.messagesPending),
        failed: sumBy(channels, (channel) => channel.messagesFailed),
      },
      jobs: {
        extracted: sumBy(channels, (channel) => channel.jobsExtracted),
        inDatabase: sumBy(channels, (channel) => channel.jobsInDatabase),
      },
      queue,
      /* A Telegram job stays out of the public feed until its apply link is
         verified, so a backed-up discovery queue looks exactly like "ingestion
         stopped" from the dashboard. Reported alongside the ingest queue so the
         difference is visible. */
      applyDiscovery,
      lastMessageAt: latest(channels.map((channel) => channel.lastMessageAt)),
      lastSyncAt: latest(channels.map((channel) => channel.lastSyncAt)),
      ingestion: {
        telegramConfigured: Boolean(
          env.TELEGRAM_SESSION && env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH,
        ),
        llmConfigured: Boolean(env.GEMINI_API_KEY),
        queueWorkerEnabled: env.QUEUE_WORKER_ENABLED,
        applyDiscoveryEnabled: env.APPLY_DISCOVERY_ENABLED,
        firecrawlConfigured: Boolean(env.FIRECRAWL_API_KEY),
      },
    },
  });
});

const statusUpdateSchema = z.object({
  status: z.enum(CHANNEL_STATUSES),
});

/**
 * PATCH /api/admin/channels/:id
 * Pauses or resumes a channel.
 *
 * Pausing stops future ingestion and nothing else: stored jobs, queued messages
 * and statistics are all left in place, so resuming continues from where the
 * channel left off.
 */
adminRouter.patch('/channels/:id', async (req: Request, res: Response) => {
  const { id } = req.params;

  if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) {
    throw badRequest('Invalid channel ID format');
  }

  const parsed = statusUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(`Invalid status. Must be one of: ${CHANNEL_STATUSES.join(', ')}.`);
  }

  const channel = await setChannelStatus(id, parsed.data.status);

  if (channel === null) {
    throw notFound('Channel not found');
  }

  res.status(200).json({ data: channel });
});
