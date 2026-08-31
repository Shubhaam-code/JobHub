import { TelegramClient } from 'telegram';
// `telegram` is CommonJS with no `exports` map, so ESM needs the explicit file
// path here — the bare directory specifier `telegram/sessions` fails to resolve.
import { StringSession } from 'telegram/sessions/index.js';

import { env } from '../config/env.js';

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
 */
export function createTelegramClient(
  sessionString: string = env.TELEGRAM_SESSION ?? '',
): TelegramClientHandle {
  const { apiId, apiHash } = readTelegramCredentials();
  const session = new StringSession(sessionString);

  const client = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5,
    deviceModel: DEVICE_MODEL,
    appVersion: APP_VERSION,
  });

  return {
    client,
    saveSession: () => session.save(),
  };
}
