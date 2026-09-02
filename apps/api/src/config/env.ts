import { config as loadDotenvFile } from 'dotenv';
import { z } from 'zod';

// Loads apps/api/.env when present. Real environment variables always win.
loadDotenvFile({ quiet: true });

const DEFAULT_MONGODB_URI = 'mongodb://127.0.0.1:27017/job_aggregator';

/**
 * Origins this project's own frontends are served from.
 *
 * These are always allowed, whether or not `CORS_ORIGINS` is set — see
 * `resolveCorsOrigins` for why merging beats replacing. Localhost is for
 * development; the rest are the deployed frontends (Vercel, and the `jia-web`
 * service in render.yaml).
 *
 * An origin is not a secret: the browser sends it in a header on every request
 * and it is visible in any network tab. This is not the authentication boundary
 * either — the admin routes are gated by the HMAC bearer token in
 * `requireAdmin`, CORS is not configured with `credentials`, so no cookie rides
 * along, and the jobs feed these origins can read is public regardless. What CORS
 * decides here is only which *page* a browser will let read a response.
 */
const BUILT_IN_CORS_ORIGINS = [
  'http://localhost:3000',
  'https://job-hub-web-ochre.vercel.app',
  'https://jobhub-jubu-web.onrender.com',
];

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
  /** Localhost default is for development only — production must set this. */
  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\/.+/, 'must start with mongodb:// or mongodb+srv://')
    .default(DEFAULT_MONGODB_URI),
  /**
   * Extra browser origins allowed to call the API, comma-separated, used for both
   * the REST routes and Socket.IO. Origins only — scheme and host, no path and no
   * trailing slash (one is stripped anyway).
   *
   * This *adds to* `BUILT_IN_CORS_ORIGINS` rather than replacing it, so set it
   * only for origins this repo does not already know about: a preview
   * deployment, a custom domain, a fork's frontend.
   */
  CORS_ORIGINS: z.string().default(''),
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
   * Cap on peers held in the session's entity store.
   *
   * GramJS's own `MemorySession` keeps these in a `Set` it can never dedup, so
   * the store grows by one row per message forever — the leak that exhausted
   * memory in production. `BoundedStringSession` replaces it with a keyed map
   * capped here. The default is far above this deployment's working set (one
   * row per configured channel plus occasional senders); raise it only if a
   * much larger channel list is configured.
   */
  TELEGRAM_ENTITY_CACHE_MAX: z.coerce.number().int().min(50).max(100_000).default(2_000),

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

  // Resume parsing (Groq, OpenAI-compatible chat completions). A separate key
  // from GEMINI_API_KEY on purpose: it has its own quota and is the only
  // provider the resume flow uses. Server-side only — never sent to the browser.
  GROQ_API_KEY: optionalValue,
  /** Must be a Groq model that supports strict JSON-schema structured outputs. */
  GROQ_MODEL: z.string().trim().min(1).default('openai/gpt-oss-20b'),

  /** Hard ceiling per LLM attempt, so ingestion never waits indefinitely. */
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(20_000),

  // ── LLM throttling ──────────────────────────────────────────────────────
  // The worker throttles itself BEFORE calling the provider, so the common case
  // is never hitting a 429 at all. Tune these to the quota of your key.
  /** Requests per rolling minute across the whole process. */
  LLM_MAX_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  /** How many LLM calls may be in flight at once. 1 = strictly serial. */
  LLM_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(1),

  // ── Ingest queue worker ─────────────────────────────────────────────────
  /**
   * How many queue messages may be processed at once.
   *
   * This is the app's memory backpressure knob: the queue lives in MongoDB, and
   * only the messages currently being processed are ever held in this process.
   * At most `QUEUE_CONCURRENCY` claimed rows (raw post text plus one LLM
   * request/response) exist in memory at any moment, regardless of how deep the
   * queue is.
   *
   * Default 1 — chosen to match the workload, not picked arbitrarily. The
   * classifier is throttled to `LLM_MAX_REQUESTS_PER_MINUTE` (10) with
   * `LLM_CONCURRENCY` (1), so a second worker slot would spend its life waiting
   * on the rate limiter while holding a claimed message in memory. Raise it only
   * alongside `LLM_CONCURRENCY`, and keep both small on a 512 MB instance.
   */
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  /** How often the worker looks for claimable messages, in ms. */
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().min(200).max(600_000).default(2_000),
  /** Attempts before a message is parked in `failed` (dead-letter). */
  QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(6),
  /** First backoff step; each further attempt doubles it (5s → 10s → 20s …). */
  QUEUE_RETRY_BASE_MS: z.coerce.number().int().min(100).max(600_000).default(5_000),
  /** Ceiling on backoff, so a long outage never schedules a retry days out. */
  QUEUE_RETRY_MAX_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(600_000),
  /**
   * A `processing` claim older than this is treated as abandoned (killed worker)
   * and returned to `pending` on the next boot or sweep.
   */
  QUEUE_STALE_CLAIM_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(300_000),
  /** Set to "false" to keep ingesting into the queue without draining it. */
  QUEUE_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  // ── Auth ────────────────────────────────────────────────────────────────
  // Accounts exist only to gate the admin dashboard. AUTH_SECRET signs the
  // bearer tokens issued by POST /api/auth/login: changing it invalidates every
  // outstanding token, which is the intended way to revoke them all.
  AUTH_SECRET: optionalValue.pipe(z.string().min(16, 'must be at least 16 characters').optional()),
  /** Lifetime of an issued token. Short by default — it only unlocks /admin. */
  AUTH_TOKEN_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(12),
  /**
   * Optional first-admin bootstrap, applied idempotently at startup. Only ever
   * creates a missing account — an existing user's password is never rewritten,
   * so leaving these set does not undo a password change.
   */
  ADMIN_EMAIL: optionalValue.pipe(
    z
      .string()
      .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'must be a valid email address')
      .optional(),
  ),
  ADMIN_PASSWORD: optionalValue.pipe(z.string().min(8, 'must be at least 8 characters').optional()),

  /** Largest resume PDF accepted by POST /api/v1/profile/resume. */
  RESUME_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(20_000_000)
    .default(5_000_000),
  /**
   * Lowest match score a job needs to be recommended at all. Raise it for
   * stricter recommendations, lower it to see more. The per-dimension weights
   * live in `src/recommendations/matching.ts`.
   */
  RECOMMENDATION_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(50),

  // ── Resource limits & observability ─────────────────────────────────────
  /**
   * Cap on pooled MongoDB connections.
   *
   * The driver defaults to 100, and each idle socket carries its own buffers —
   * a large reserve of memory this workload never needs. One HTTP process plus
   * a serial queue worker is served comfortably by a handful of connections.
   */
  MONGODB_MAX_POOL_SIZE: z.coerce.number().int().min(1).max(500).default(10),
  /**
   * How often the memory reporter logs a process snapshot (RSS, heap, queue
   * depth, active jobs), in ms. Set to 0 to disable it.
   *
   * One short line per interval, with no message text, prompts or user data in
   * it — this is what makes a slow climb visible in Render's log stream before
   * it becomes an OOM kill.
   */
  MEMORY_REPORT_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),
  /**
   * Concurrent resume parses allowed. Each one holds an uploaded PDF (up to
   * `RESUME_MAX_BYTES`) plus its extracted text while it runs, so this bounds
   * the upload path's memory the same way `QUEUE_CONCURRENCY` bounds the
   * worker's. Requests past the limit wait their turn rather than being
   * rejected, so behaviour is unchanged.
   */
  RESUME_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppEnv extends RawEnv {
  /** CORS_ORIGINS split into a list of individual origins. */
  corsOrigins: string[];
  /** TELEGRAM_CHANNELS split into individual channel usernames (without @). */
  telegramChannels: string[];
  /** Key used to sign auth tokens — AUTH_SECRET, or a dev-only stand-in. */
  authSecret: string;
  isDevelopment: boolean;
  isProduction: boolean;
  isTest: boolean;
}

/**
 * Placeholder signing key used only when AUTH_SECRET is unset outside
 * production. It is a fixed string so tokens survive a `tsx watch` restart
 * during development; production refuses to boot without a real secret.
 */
const DEV_AUTH_SECRET = 'insecure-development-only-auth-secret';

/**
 * Refuses to boot when a variable that has a localhost default was left unset in
 * production.
 *
 * The defaults exist so local development and tests need no configuration. In a
 * deployment, silently falling back to one is worse than not starting: a
 * localhost MONGODB_URI connects to nothing, and a localhost CORS_ORIGINS blocks
 * the real frontend with a browser error that reads as a frontend bug. Same
 * fail-fast shape as `resolveAuthSecret` below.
 */
function requireInProduction(
  raw: string | undefined,
  nodeEnv: RawEnv['NODE_ENV'],
  name: string,
  hint: string,
): void {
  if (nodeEnv !== 'production') return;
  if (raw !== undefined && raw.trim().length > 0) return;

  throw new Error(
    `Invalid environment configuration:\n  - ${name}: required in production (${hint})`,
  );
}

/**
 * Splits CORS_ORIGINS into origins a browser can actually match: trims
 * whitespace, ignores empty entries, and removes duplicates.
 *
 * A trailing slash is dropped because the browser's `Origin` header never has
 * one — `https://app.vercel.app/` would match nothing at all, which is the most
 * common way an otherwise correct deployment still fails CORS.
 */
function parseOriginList(raw: string): string[] {
  const seen = new Set<string>();
  const origins: string[] = [];

  for (const entry of raw.split(',')) {
    const origin = entry.trim().replace(/\/+$/, '');
    if (origin.length === 0) continue;
    if (seen.has(origin)) continue;

    seen.add(origin);
    origins.push(origin);
  }

  return origins;
}

/**
 * The allow-list: this project's own frontends, plus whatever `CORS_ORIGINS` adds.
 *
 * `CORS_ORIGINS` used to *replace* the built-in list, and that is the bug this
 * merge fixes. The deployed API's dashboard value did not include the live
 * frontend, so `Access-Control-Allow-Origin` was absent from every response and
 * the browser discarded data the API had already produced: `curl` saw all 453
 * jobs, the site showed an empty feed, and nothing in the logs mentioned CORS.
 * Only `/welcome` had content, because it fetches server-side where CORS does not
 * apply — which made it look like a frontend rendering bug.
 *
 * Merging removes the failure mode entirely: a stale or misspelled variable can
 * no longer take the frontend offline, only fail to add an origin. Restricting
 * the deployed frontends is not a thing this variable can do any more, which is
 * the intended trade — see `BUILT_IN_CORS_ORIGINS` for why that costs nothing.
 */
function resolveCorsOrigins(raw: string): string[] {
  return parseOriginList([...BUILT_IN_CORS_ORIGINS, raw].join(','));
}

/**
 * Resolves the token signing key. Missing AUTH_SECRET is fatal in production —
 * a guessable key there would make admin tokens forgeable — and a warning
 * everywhere else, so tests and local development need no configuration.
 */
function resolveAuthSecret(secret: string | undefined, nodeEnv: RawEnv['NODE_ENV']): string {
  if (secret) return secret;

  if (nodeEnv === 'production') {
    throw new Error(
      'Invalid environment configuration:\n  - AUTH_SECRET: required in production (min 16 characters)',
    );
  }

  // console, not the logger: lib/logger.ts reads this module.
  console.warn(
    '[env] AUTH_SECRET is not set — using an insecure development key. Set AUTH_SECRET in apps/api/.env.',
  );

  return DEV_AUTH_SECRET;
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
  const corsOrigins = resolveCorsOrigins(data.CORS_ORIGINS);

  requireInProduction(
    source.MONGODB_URI,
    data.NODE_ENV,
    'MONGODB_URI',
    'set the mongodb+srv:// connection string of the deployed database',
  );

  /* No production check on CORS_ORIGINS any more: it is purely additive now, so
     an unset, empty or comma-mangled value cannot produce an empty allow-list —
     `BUILT_IN_CORS_ORIGINS` is always in it. There is nothing left here that
     could take the frontend down, so there is nothing to refuse to boot over. */

  return {
    ...data,
    corsOrigins,
    telegramChannels: parseChannelList(data.TELEGRAM_CHANNELS),
    authSecret: resolveAuthSecret(data.AUTH_SECRET, data.NODE_ENV),
    isDevelopment: data.NODE_ENV === 'development',
    isProduction: data.NODE_ENV === 'production',
    isTest: data.NODE_ENV === 'test',
  };
}

export const env = parseEnv();
