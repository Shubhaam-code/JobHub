/**
 * Resolution of the configured channel list to Telegram entities.
 *
 * Shared by the live listener and the standalone backfill script so both work
 * from exactly the same TELEGRAM_CHANNELS list, with the same warnings.
 */

import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export interface ResolvedChannel {
  entity: Api.Channel;
  /** Numeric channel ID — used for efficient event filtering. */
  id: bigInt.BigInteger;
  /** Canonical username (no @) — the dedup key and message-URL base. */
  username: string;
  title: string;
}

export interface ChannelResolution {
  resolved: ResolvedChannel[];
  /** Configured usernames that could not be resolved or read. */
  failed: string[];
}

/** The slice of the GramJS client this module needs. */
export type EntityResolver = Pick<TelegramClient, 'getEntity'>;

/**
 * Resolves every configured channel username, skipping (never failing on) the
 * ones Telegram cannot give us. Logs one line per channel — usernames and
 * titles only, never credentials.
 */
export async function resolveConfiguredChannels(
  client: EntityResolver,
  usernames: string[] = env.telegramChannels,
): Promise<ChannelResolution> {
  if (usernames.length === 0) {
    throw new Error('No channels configured. Set TELEGRAM_CHANNELS in apps/api/.env');
  }

  logger.info(`[channels] Resolving ${usernames.length} channel(s)...`);

  const resolved: ResolvedChannel[] = [];
  const failed: string[] = [];

  for (const username of usernames) {
    try {
      const entity = await client.getEntity(username);

      if (!(entity instanceof Api.Channel)) {
        logger.warn(`[channels] @${username} resolved to ${entity.className}, not a Channel.`);
        failed.push(username);
        continue;
      }

      resolved.push({
        entity,
        id: entity.id,
        // Telegram's own casing wins, so message URLs and the dedup key match
        // what the channel actually publishes.
        username: entity.username ?? username,
        title: entity.title,
      });

      logger.info(`[channels] @${username} → "${entity.title}"`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`[channels] Could not resolve @${username}: ${message}`);
      failed.push(username);
    }
  }

  logger.info(`[channels] Resolved ${resolved.length}/${usernames.length}.`);

  if (failed.length > 0) {
    logger.warn(`[channels] Unresolved: ${failed.map((name) => `@${name}`).join(', ')}`);
  }

  return { resolved, failed };
}
