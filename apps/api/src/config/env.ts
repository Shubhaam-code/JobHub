import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';

// Loads apps/api/.env when present. Real environment variables always win.
loadDotenvFile({ quiet: true });

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/job_aggregator';

/**
 * Telegram and LLM credentials are optional so the API still boots without
 * them, and a blank value in `.env` counts as "not set" rather than as invalid
 * input.
 */
const optionalValue = z
  .string()
  .trim()
  .optional()
  .transform((value) => (value ? value : undefined));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\/.+/, 'must start with mongodb:// or mongodb+srv://')
    .default(DEFAULT_MONGODB_URI),
  CORS_ORIGINS: z.string().min(1).default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),

  // Telegram (MTProto via GramJS). api_id/api_hash come from https://my.telegram.org.
  // TELEGRAM_SESSION is produced by `npm run telegram:login` and is a full account
  // credential: treat it exactly like a password.
  TELEGRAM_API_ID: optionalValue.pipe(
    z
      .string()
      .regex(/^\d+$/, 'must be the numeric api_id issued by my.telegram.org')
      .transform((value) => Number(value))
      .optional(),
  ),
  TELEGRAM_API_HASH: optionalValue.pipe(
    z
      .string()
      .regex(/^[0-9a-f]{32}$/i, 'must be the 32-character api_hash issued by my.telegram.org')
      .optional(),
  ),
  TELEGRAM_SESSION: optionalValue,

  /**
   * Comma-separated list of public Telegram channel usernames to listen to.
   * Example: "jobs_and_internships_updates,another_jobs_channel"
   * Defaults to the legacy single channel if not provided.
   */
  TELEGRAM_CHANNELS: z.string().trim().default('jobs_and_internships_updates'),

  // LLM (Google Gemini via @google/genai) used to classify posts and extract
  // fields. Optional: without a key the API still boots, but no post can be
  // classified, so nothing is ingested.
  GEMINI_API_KEY: optionalValue,
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.7-flash'),
  /** Hard ceiling per LLM attempt, so ingestion never waits indefinitely. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppEnv extends RawEnv {
  /** CORS_ORIGINS split into a list of individual origins. */
  corsOrigins: string[];
  /** TELEGRAM_CHANNELS split into individual channel usernames (without @). */
  telegramChannels: string[];
  isDevelopment: boolean;
  isProduction: boolean;
  isTest: boolean;
}

/**
 * Splits TELEGRAM_CHANNELS into usernames: trims whitespace, drops an optional
 * leading "@", ignores empty entries, and removes duplicates. Telegram
 * usernames are case-insensitive, so "@Jobsvillaa" and "jobsvillaa" are the
 * same channel and must not be resolved or backfilled twice.
 */
function parseChannelList(raw: string): string[] {
  const seen = new Set<string>();
  const channels: string[] = [];

  for (const entry of raw.split(',')) {
    const username = entry.trim().replace(/^@/, '');
    if (username.length === 0) continue;

    const key = username.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    channels.push(username);
  }

  return channels;
}

/**
 * Validates a set of environment variables and returns the typed config.
 * Exported separately from `env` so it can be unit tested with fixtures.
 */
export function parseEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const data = result.data;

  return {
    ...data,
    corsOrigins: data.CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    telegramChannels: parseChannelList(data.TELEGRAM_CHANNELS),
    isDevelopment: data.NODE_ENV === 'development',
    isProduction: data.NODE_ENV === 'production',
    isTest: data.NODE_ENV === 'test',
  };
}

export const env = parseEnv();
