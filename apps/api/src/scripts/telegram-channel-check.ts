/**
 * Read-access check for every channel in TELEGRAM_CHANNELS.
 *
 *   npm run telegram:channel-check --workspace @jia/api
 *
 * For each configured channel it resolves the username, fetches the latest few
 * messages, and prints safe metadata (id, date, whether text exists, a short
 * preview, the public t.me URL). Exit code 0 means every channel is readable;
 * 1 means at least one is not.
 *
 * Deliberately does nothing else: no listeners, no storage, no classification,
 * no sending, no joining/leaving. Nothing fetched is written to disk or to the
 * database.
 */
import { Api, errors } from 'telegram';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  createTelegramClient,
  readTelegramCredentials,
  TelegramConfigError,
} from '../telegram/client.js';
import type { TelegramClientHandle } from '../telegram/client.js';

const MESSAGE_LIMIT = 3;
const PREVIEW_LENGTH = 100;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Single-line, length-capped excerpt so a long post cannot flood the terminal. */
function preview(text: string): string {
  const flattened = text.replace(/\s+/g, ' ').trim();

  return flattened.length > PREVIEW_LENGTH ? `${flattened.slice(0, PREVIEW_LENGTH)}...` : flattened;
}

/**
 * Adds an operator-facing hint to the Telegram error codes this script can
 * realistically hit. Flood waits are reported, never retried.
 */
function explainError(username: string, error: unknown): string {
  if (error instanceof errors.FloodWaitError) {
    return `Telegram rate limit (FLOOD_WAIT): wait ${error.seconds}s before trying again. Not retrying.`;
  }

  const code = error instanceof errors.RPCError ? error.errorMessage : '';

  if (code === 'USERNAME_NOT_OCCUPIED' || code === 'USERNAME_INVALID') {
    return `Telegram does not know @${username} (${code}) - the channel was renamed or deleted.`;
  }

  if (code === 'CHANNEL_PRIVATE' || code === 'CHANNEL_INVALID') {
    return `@${username} is not publicly readable by this account (${code}).`;
  }

  return errorMessage(error);
}

async function tearDown(handle: TelegramClientHandle): Promise<void> {
  try {
    await handle.client.destroy();
  } catch (error) {
    logger.debug(`Ignoring Telegram teardown error: ${errorMessage(error)}`);
  }
}

/** Waits for queued stdout writes to flush before the process exits. */
async function flushStdout(): Promise<void> {
  await new Promise<void>((resolve) => {
    process.stdout.write('', () => resolve());
  });
}

/** Checks one channel. Returns true when it resolved and returned messages. */
async function checkChannel(handle: TelegramClientHandle, username: string): Promise<boolean> {
  try {
    const entity = await handle.client.getEntity(username);

    if (!(entity instanceof Api.Channel)) {
      logger.warn(`@${username}: resolved to ${entity.className}, not a channel — skipping.`);
      return false;
    }

    const kind = entity.megagroup ? 'public group' : 'public broadcast channel';
    const messages = await handle.client.getMessages(entity, { limit: MESSAGE_LIMIT });

    console.log(
      [
        '',
        `@${username} — "${entity.title}" (id ${String(entity.id)}, ${kind})`,
        `  messages read: ${messages.length}`,
      ].join('\n'),
    );

    for (const message of messages) {
      // Media-only and service messages carry no text, so this can be empty.
      const text = typeof message.message === 'string' ? message.message : '';
      const url = entity.username ? `https://t.me/${entity.username}/${message.id}` : '(none)';

      console.log(
        [
          `  - id ${message.id} | ${new Date(message.date * 1000).toISOString()} | ${url}`,
          `    ${text.length > 0 ? preview(text) : '(no text)'}`,
        ].join('\n'),
      );
    }

    if (messages.length === 0) {
      logger.warn(`@${username}: resolved but read 0 messages — treating it as unreadable.`);
      return false;
    }

    return true;
  } catch (error: unknown) {
    logger.warn(`@${username}: ${explainError(username, error)}`);
    return false;
  }
}

async function main(): Promise<void> {
  readTelegramCredentials();

  if (!env.TELEGRAM_SESSION) {
    throw new TelegramConfigError(
      'TELEGRAM_SESSION is not set. Run `npm run telegram:login --workspace @jia/api` first, ' +
        'then put the printed session string in apps/api/.env.',
    );
  }

  const channels = env.telegramChannels;

  if (channels.length === 0) {
    throw new Error('No channels configured. Set TELEGRAM_CHANNELS in apps/api/.env.');
  }

  const handle = createTelegramClient();
  // 0 disables GramJS's automatic sleep-and-repeat on short flood waits, so a
  // rate limit surfaces as an error to report instead of a silent retry.
  handle.client.floodSleepThreshold = 0;

  try {
    await handle.client.connect();

    if (!(await handle.client.isUserAuthorized())) {
      throw new Error('The saved session is not authorized (revoked, or logged out).');
    }

    logger.info(`Connected. Checking ${channels.length} configured channel(s)...`);

    const failed: string[] = [];

    for (const username of channels) {
      const ok = await checkChannel(handle, username);
      if (!ok) failed.push(username);
    }

    console.log('');
    logger.info(`Readable: ${channels.length - failed.length}/${channels.length}`);

    if (failed.length > 0) {
      logger.warn(`Not readable: ${failed.map((name) => `@${name}`).join(', ')}`);
      throw new Error(`${failed.length} configured channel(s) could not be read.`);
    }
  } finally {
    await tearDown(handle);
  }
}

try {
  await main();
  await flushStdout();
  // GramJS keeps timers and sockets alive; exit explicitly so the script ends.
  process.exit(0);
} catch (error) {
  if (error instanceof TelegramConfigError) {
    logger.error(error.message);
  } else {
    logger.error(`Channel access check failed: ${errorMessage(error)}`);
  }

  await flushStdout();
  process.exit(1);
}
