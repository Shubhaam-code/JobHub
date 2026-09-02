import { TelegramClient } from 'telegram';

import { env } from '../config/env.js';
import { BoundedStringSession } from './bounded-session.js';

/** Shown in Telegram > Settings > Devices, so this login is easy to spot and revoke. */
const DEVICE_MODEL = 'job-internship-aggregator';
const APP_VERSION = '0.1.0';

/** Thrown when the Telegram environment variables are missing. */
export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramConfigError';
  }
}

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

export interface TelegramClientHandle {
  client: TelegramClient;
  /**
   * Serialises the live session. The result is a full account credential, so it
   * must only ever reach the operator's terminal or `apps/api/.env`.
   */
  saveSession(): string;
  /**
   * The session's bounded entity store. Exposed so teardown can release it and
   * the memory reporter can read its size — never its contents.
   */
  session: BoundedStringSession;
}

/**
 * Reads api_id/api_hash from the validated environment.
 * @throws TelegramConfigError when either value is absent.
 */
export function readTelegramCredentials(): TelegramCredentials {
  const apiId = env.TELEGRAM_API_ID;
  const apiHash = env.TELEGRAM_API_HASH;

  if (apiId === undefined || apiHash === undefined) {
    const missing = [
      apiId === undefined ? 'TELEGRAM_API_ID' : undefined,
      apiHash === undefined ? 'TELEGRAM_API_HASH' : undefined,
    ].filter((name) => name !== undefined);

    throw new TelegramConfigError(
      `Missing Telegram credentials: ${missing.join(', ')}. Create an application at ` +
        'https://my.telegram.org (API development tools), then set the values in apps/api/.env.',
    );
  }

  return { apiId, apiHash };
}

/**
 * Builds an unconnected MTProto client backed by a string session.
 *
 * Pass an empty string to start a fresh login; omit the argument to resume the
 * session from `TELEGRAM_SESSION`. Callers own connecting and disconnecting.
 *
 * The session is a `BoundedStringSession` rather than GramJS's `StringSession`:
 * same serialization format and the same `TELEGRAM_SESSION` string, but its
 * entity store cannot grow without bound. See `bounded-session.ts`.
 */
export function createTelegramClient(
  sessionString: string = env.TELEGRAM_SESSION ?? '',
): TelegramClientHandle {
  const { apiId, apiHash } = readTelegramCredentials();
  const session = new BoundedStringSession(sessionString, env.TELEGRAM_ENTITY_CACHE_MAX);

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: DEVICE_MODEL,
    appVersion: APP_VERSION,
  });

  return {
    client,
    session,
    saveSession: () => session.save(),
  };
}
