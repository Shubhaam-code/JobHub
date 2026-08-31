/**
 * Interactive Telegram (MTProto) login.
 *
 *   npm run telegram:login --workspace @jia/api
 *
 * With no TELEGRAM_SESSION set, it walks the GramJS user auth flow and prints a
 * session string to paste into apps/api/.env. With one set, it reconnects and
 * verifies the session still works without asking for a login code.
 *
 * The session string is printed to this terminal only. It is never written to a
 * file, logged elsewhere, or sent anywhere.
 */
import { createInterface, type Interface } from 'node:readline/promises';

import type { Api } from 'telegram';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  createTelegramClient,
  readTelegramCredentials,
  TelegramConfigError,
} from '../telegram/client.js';
import type { TelegramClientHandle } from '../telegram/client.js';

/**
 * Telegram errors the operator can recover from by re-entering the value.
 * Anything else aborts, because GramJS otherwise retries its prompt forever.
 */
const RETRYABLE_ERRORS = [
  'PHONE_CODE_INVALID',
  'PHONE_CODE_EMPTY',
  'PHONE_CODE_EXPIRED',
  'PHONE_NUMBER_INVALID',
  'PASSWORD_HASH_INVALID',
  'Code is empty',
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRetryable(error: Error): boolean {
  const rpcCode = (error as { errorMessage?: unknown }).errorMessage;
  const haystack = `${error.message} ${typeof rpcCode === 'string' ? rpcCode : ''}`;

  return RETRYABLE_ERRORS.some((code) => haystack.includes(code));
}

function describeUser(user: Api.User): string {
  const name = [user.firstName, user.lastName].filter((part) => Boolean(part)).join(' ');
  const handle = user.username ? `@${user.username}` : 'no username';

  return `${name || '(no name)'} (${handle}, id ${String(user.id)})`;
}

/**
 * Terminal input plus a signal that fires when stdin closes. GramJS re-prompts
 * in a loop on recoverable errors, so an unanswerable prompt (Ctrl+D, piped
 * stdin) has to abort rather than resolve empty forever.
 */
interface TerminalInput {
  rl: Interface;
  signal: AbortSignal;
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR';
}

async function ask(input: TerminalInput, question: string): Promise<string> {
  try {
    return (await input.rl.question(question, { signal: input.signal })).trim();
  } catch (error) {
    if (isAbortError(error)) throw new Error('AUTH_USER_CANCEL');
    throw error;
  }
}

/**
 * Like ask(), but echoes nothing at all while the answer is typed (sudo-style),
 * so a 2FA password cannot end up in terminal scrollback. Suppressing every
 * write — not masking characters — is what makes readline's full-line refresh
 * safe, since that refresh re-emits the whole buffer.
 */
async function askSecret(input: TerminalInput, question: string): Promise<string> {
  const writable = input.rl as unknown as { _writeToOutput: (text: string) => void };
  const restoreOutput = writable._writeToOutput;

  process.stdout.write(question);
  writable._writeToOutput = () => undefined;

  try {
    return await ask(input, '');
  } finally {
    writable._writeToOutput = restoreOutput;
    process.stdout.write('\n');
  }
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

function printSession(session: string): void {
  const rule = '-'.repeat(76);

  console.log(
    [
      '',
      rule,
      'Add this to apps/api/.env (already gitignored):',
      '',
      `TELEGRAM_SESSION=${session}`,
      '',
      'This string is a full account credential. Anyone holding it can act as the',
      'account without a login code. Never commit it, paste it into a chat/issue,',
      'or return it from an API response. If it leaks, revoke it in Telegram under',
      'Settings > Devices.',
      rule,
      '',
    ].join('\n'),
  );
}

/**
 * Proves requirement 4: an existing session reconnects with no login code.
 * Returns false when the session is unusable so the caller can log in again.
 */
async function reconnectWithSavedSession(): Promise<boolean> {
  logger.info('TELEGRAM_SESSION is set - reconnecting without a login code...');

  let handle: TelegramClientHandle;

  try {
    // StringSession decodes eagerly, so a corrupt value throws right here.
    handle = createTelegramClient();
  } catch {
    // The underlying error embeds raw session bytes, so it is deliberately not
    // logged: session material must never reach a terminal or a log file.
    logger.warn('TELEGRAM_SESSION could not be decoded - the value looks corrupt or truncated.');
    return false;
  }

  try {
    await handle.client.connect();

    if (!(await handle.client.isUserAuthorized())) {
      logger.warn('The saved session is no longer authorized (revoked, or logged out).');
      return false;
    }

    const me = await handle.client.getMe();
    logger.info(`Reconnected as ${describeUser(me)} - no login code was requested.`);
    return true;
  } catch (error) {
    logger.warn(`Could not reuse TELEGRAM_SESSION: ${errorMessage(error)}`);
    return false;
  } finally {
    await tearDown(handle);
  }
}

/** GramJS's official user auth flow, driven from the terminal. */
async function interactiveLogin(input: TerminalInput): Promise<void> {
  logger.info('Starting interactive Telegram login over MTProto.');
  console.log(
    '\nSign in with the dedicated Telegram account for this project.\n' +
      'Telegram sends the login code to that account (in-app, or by SMS).\n' +
      'Nothing you type here is stored on disk.\n',
  );

  const handle = createTelegramClient('');

  try {
    await handle.client.start({
      phoneNumber: () => ask(input, 'Phone number (international format, e.g. +911234567890): '),
      phoneCode: (isCodeViaApp) =>
        ask(input, `Login code (sent ${isCodeViaApp ? 'in the Telegram app' : 'by SMS'}): `),
      password: (hint) =>
        askSecret(input, `Two-step verification password${hint ? ` (hint: ${hint})` : ''}: `),
      onError: async (error) => {
        if (error.message === 'AUTH_USER_CANCEL') return true;

        if (isRetryable(error)) {
          logger.warn(`Telegram rejected that value (${error.message}) - try again.`);
          return false;
        }

        logger.error(`Telegram authentication error: ${error.message}`);
        return true;
      },
    });

    const me = await handle.client.getMe();
    const session = handle.saveSession();

    logger.info(`Signed in as ${describeUser(me)}`);
    printSession(session);
  } finally {
    await tearDown(handle);
  }
}

async function main(): Promise<void> {
  // Fail fast and loudly before prompting for anything.
  readTelegramCredentials();

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const closed = new AbortController();
  rl.on('close', () => closed.abort());

  try {
    if (env.TELEGRAM_SESSION && (await reconnectWithSavedSession())) {
      return;
    }

    await interactiveLogin({ rl, signal: closed.signal });
  } finally {
    rl.close();
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
  } else if (errorMessage(error) === 'AUTH_USER_CANCEL') {
    logger.error('Telegram login aborted.');
  } else {
    logger.error(`Telegram login failed: ${errorMessage(error)}`);
  }

  await flushStdout();
  process.exit(1);
}
