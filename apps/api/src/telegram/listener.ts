/**
 * GramJS new-message listener for configured Telegram channels.
 *
 * Reads channel usernames from env.telegramChannels (TELEGRAM_CHANNELS env var).
 * Resolves each channel once at startup, caches numeric peer IDs, and filters
 * incoming events by those IDs.
 *
 * Startup order: register the live handler, then backfill the last 7 days per
 * channel, so no post that arrives mid-backfill is missed.
 */

import { errors } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isLlmConfigured, llmModelName } from '../llm/client.js';
import { runBackfill, type BackfillSummary } from './backfill.js';
import {
  ensureConfiguredChannels,
  isChannelIngestionEnabled,
  registerResolvedChannel,
} from './channel-registry.js';
import { resolveConfiguredChannels } from './channels.js';
import type { TelegramClientHandle } from './client.js';
import { ingestMessage } from './ingestion.js';

export interface ListenerHandle {
  /** Results of the startup backfill per channel. */
  backfill: BackfillSummary[];
  /** Stops the listener and disconnects the client. */
  stop(): Promise<void>;
}

/**
 * Starts the new-message listener.
 *
 * 1. Resolves all configured channels → caches numeric IDs, records the registry.
 * 2. Registers a NewMessage handler that filters by cached IDs.
 * 3. Backfills the last 7 days for each channel through the same pipeline.
 * 4. Returns a handle whose `stop()` tears everything down.
 *
 * Ingestion only normalizes and enqueues, so the listener keeps up with Telegram
 * regardless of what the LLM is doing.
 */
export async function startListener(handle: TelegramClientHandle): Promise<ListenerHandle> {
  const { client } = handle;

  if (!isLlmConfigured()) {
    logger.warn(
      '[listener] GEMINI_API_KEY is not set — messages will still be queued, but nothing can be ' +
        'classified or stored until it is. Set it in apps/api/.env.',
    );
  } else {
    logger.info(`[listener] Classifier model: ${llmModelName()}`);
  }

  // ── Resolve all configured channels ──────────────────────────────────────

  // Registered first, so the admin dashboard lists a channel even if Telegram
  // cannot resolve it right now. Never re-enables an admin-paused channel.
  await ensureConfiguredChannels();

  const { resolved } = await resolveConfiguredChannels(client);

  if (resolved.length === 0) {
    throw new Error('[listener] None of the configured channels could be resolved.');
  }

  // Records numeric IDs and titles so the registry can describe each channel.
  for (const channel of resolved) {
    await registerResolvedChannel({
      username: channel.username,
      title: channel.title,
      telegramId: channel.id.toString(),
    });
  }

  // Concise startup summary. Never logs credentials — usernames and titles only.
  const summaryLines = resolved.map((ch) => `  - @${ch.username} ("${ch.title}")`).join('\n');
  const configuredCount = env.telegramChannels.length;
  logger.info(
    `[listener] Configured channels: ${configuredCount}\n` +
      `[listener] Resolved: ${resolved.length}\n${summaryLines}` +
      (resolved.length < configuredCount
        ? `\n[listener] Skipped: ${configuredCount - resolved.length} (see warnings above)`
        : ''),
  );

  // Build a lookup set for fast event filtering
  const channelIdSet = new Set(resolved.map((ch) => ch.id.toString()));
  const channelByIdStr = new Map(resolved.map((ch) => [ch.id.toString(), ch]));

  // ── Event handler ─────────────────────────────────────────────────────────

  async function onNewMessage(event: NewMessageEvent): Promise<void> {
    try {
      const message = event.message;
      const chatId = message.chatId;

      if (chatId === undefined) return;

      const chatIdStr = chatId.toString();
      if (!channelIdSet.has(chatIdStr)) return;

      const channel = channelByIdStr.get(chatIdStr);
      if (!channel) return;

      const text = message.message ?? '';
      if (!text.trim()) {
        logger.debug(`[listener] @${channel.username} msg ${message.id}: no text — skipped`);
        return;
      }

      await ingestMessage({
        text,
        messageId: message.id,
        date: message.date,
        channelUsername: channel.username,
        channelId: channel.id.toString(),
      });
    } catch (error: unknown) {
      if (error instanceof errors.FloodWaitError) {
        logger.warn(`[listener] FLOOD_WAIT: wait ${error.seconds}s — not retrying`);
        return;
      }

      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[listener] Error processing message: ${msg}`);
    }
  }

  // Register BEFORE backfill so mid-backfill posts are not missed.
  client.addEventHandler(onNewMessage, new NewMessage({}));

  logger.info('[listener] Live handler registered — new posts are ingested from now on.');

  // ── Backfill each channel ─────────────────────────────────────────────────

  const backfillResults: BackfillSummary[] = [];

  for (const channel of resolved) {
    // A paused channel is not walked at all. The per-message check already
    // blocks its ingestion, so this only avoids a pointless history read.
    if (!(await isChannelIngestionEnabled(channel.username))) {
      logger.info(`[listener] @${channel.username} is paused — backfill skipped.`);
      continue;
    }

    try {
      const summary = await runBackfill({
        client,
        entity: channel.entity,
        channelUsername: channel.username,
        channelId: channel.id.toString(),
      });
      backfillResults.push(summary);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`[listener] Backfill failed for @${channel.username}: ${msg}`);
    }
  }

  logger.info('[listener] All channels live. Press Ctrl+C to stop.');

  // ── Teardown handle ───────────────────────────────────────────────────────

  let stopped = false;

  return {
    backfill: backfillResults,

    async stop() {
      if (stopped) return;
      stopped = true;

      logger.info('[listener] Stopping...');
      client.removeEventHandler(onNewMessage, new NewMessage({}));

      try {
        await client.disconnect();
      } catch {
        // Ignore disconnect errors during teardown.
      }

      logger.info('[listener] Stopped.');
    },
  };
}
