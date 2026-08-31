/**
 * Minimal LLM provider wrapper (Google Gemini via `@google/genai`).
 *
 * One responsibility: given a system instruction, a prompt and a JSON schema,
 * return parsed JSON that conforms to the schema — or a reason why it could not.
 * No framework, no agents, no chains.
 *
 * Every call is throttled by `llmRateLimiter` first. A 429 is reported back to
 * the caller as `{ rateLimited: true, retryAfterMs }` so the ingest queue can
 * park the message and retry it later; callers that want the old in-process
 * wait-and-retry behaviour get it by leaving `maxAttempts` unset.
 */

import { GoogleGenAI } from '@google/genai';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { llmRateLimiter } from './rate-limiter.js';

export type StructuredResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: string;
      /** True when the provider refused with a 429. The failure is transient. */
      rateLimited?: boolean;
      /** Provider-supplied wait before retrying, when it gave one. */
      retryAfterMs?: number;
    };

/** Plain JSON Schema — the shape both call paths below accept. */
export type JsonSchema = Record<string, unknown>;

export interface StructuredRequest {
  systemInstruction: string;
  prompt: string;
  schema: JsonSchema;
  /** Caps a single attempt. Defaults to env.LLM_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Output ceiling for this request. Defaults to MAX_OUTPUT_TOKENS, which suits
   * the short classification object; a request that returns several arrays
   * (resume parsing) needs more room or the JSON is truncated mid-object.
   */
  maxOutputTokens?: number;
  /**
   * Attempts inside this call. Defaults to MAX_ATTEMPTS.
   *
   * Pass 1 when a durable queue owns the retry: the call then returns
   * immediately with `rateLimited`/`retryAfterMs` instead of sleeping, leaving
   * the worker free to process other messages.
   */
  maxAttempts?: number;
}


/**
 * Up to 4 attempts on rate-limit or transient errors.
 * Gemini free tier is 15 RPM; each 429 includes the exact retryDelay we use.
 */
const MAX_ATTEMPTS = 4;
const DEFAULT_RETRY_DELAY_MS = 5_000;
const MAX_OUTPUT_TOKENS = 512;

let cachedClient: GoogleGenAI | null = null;

/** True when an API key is configured, i.e. classification can run at all. */
export function isLlmConfigured(): boolean {
  return env.GEMINI_API_KEY !== undefined;
}

/** Model id in use — safe to log (never a key). */
export function llmModelName(): string {
  return env.GEMINI_MODEL;
}

/** Lazily builds the client so the API boots fine without an API key. */
function getClient(): GoogleGenAI | null {
  if (!isLlmConfigured()) return null;
  cachedClient ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  return cachedClient;
}

/** Test seam: drops the cached client so a changed key/model is picked up. */
export function resetLlmClient(): void {
  cachedClient = null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects when `ms` elapses, so one slow call cannot stall ingestion. */
function timeout(ms: number): { promise: Promise<never>; cancel: () => void } {
  let handle: NodeJS.Timeout;
  const promise = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`LLM call timed out after ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

/**
 * Strips a ```json fence when a model wraps its JSON despite being asked for a
 * bare object. Cheap tolerance, not free-form parsing.
 */
function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * True when the model is a Gemini 2.5-* variant that supports thinkingConfig.
 * Only 2.5 family supports thinkingBudget; 3.5-flash-lite, 2.0, and 1.5 do NOT.
 */
function modelSupportsThinking(modelName: string): boolean {
  // Only the 2.5 family (2.5-flash, 2.5-pro) supports thinkingConfig.
  return /^models\/gemini-2\.5|^gemini-2\.5/i.test(modelName);
}

/**
 * Reads the provider's requested wait, in milliseconds, or null when it did not
 * give one. Recognises Gemini's RetryInfo (`"retryDelay": "59s"`) and an HTTP
 * `Retry-After` echoed into the error text, in seconds or as a date.
 *
 * A 1s buffer is added so the retry lands just after the window opens rather
 * than exactly on the boundary, where it would be refused again.
 */
export function parseRetryDelayMs(error: unknown, nowMs: number = Date.now()): number | null {
  const text = errorText(error);

  const retryDelay = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  const seconds = retryDelay?.[1];
  if (seconds !== undefined) {
    return Math.ceil(parseFloat(seconds) * 1000) + 1_000;
  }

  const retryAfter = /retry[-_]?after"?\s*[:=]\s*"?(\d+(?:\.\d+)?)"?/i.exec(text);
  const afterSeconds = retryAfter?.[1];
  if (afterSeconds !== undefined) {
    return Math.ceil(parseFloat(afterSeconds) * 1000) + 1_000;
  }

  const retryAfterDate = /retry[-_]?after"?\s*[:=]\s*"([^"]+)"/i.exec(text)?.[1];
  if (retryAfterDate !== undefined) {
    const parsed = Date.parse(retryAfterDate);
    if (!Number.isNaN(parsed) && parsed > nowMs) {
      return parsed - nowMs + 1_000;
    }
  }

  return null;
}

/**
 * Extracts the retry delay in milliseconds from a Gemini 429 error response,
 * falling back to DEFAULT_RETRY_DELAY_MS when the response carried none.
 */
function extractRetryDelayMs(error: unknown): number {
  return parseRetryDelayMs(error) ?? DEFAULT_RETRY_DELAY_MS;
}

/**
 * True when the error is a Gemini 429 rate-limit response (RESOURCE_EXHAUSTED).
 */
export function isRateLimitError(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes('"code":429') ||
    text.includes('"status":"RESOURCE_EXHAUSTED"') ||
    /\b429\b/.test(text) ||
    /rate\s*limit/i.test(text)
  );
}

/**
 * Asks the model for JSON matching `schema` and returns it parsed.
 *
 * Uses `models.generateContent` with structured output. thinkingConfig is only
 * sent for models that support it (gemini-2.5 family) to avoid INVALID_ARGUMENT
 * errors on lite/flash models.
 */
async function callProvider(
  client: GoogleGenAI,
  request: StructuredRequest,
  signalTimeoutMs: number,
): Promise<string> {
  const { promise: timeoutPromise, cancel } = timeout(signalTimeoutMs);

  try {
    const response = await Promise.race([
      client.models.generateContent({
        model: env.GEMINI_MODEL,
        contents: request.prompt,
        config: {
          systemInstruction: request.systemInstruction,
          responseMimeType: 'application/json',
          responseJsonSchema: request.schema,
          temperature: 0,
          maxOutputTokens: request.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
          // Only send thinkingConfig for gemini-2.5-* models.
          // 3.5-flash-lite and 2.0 reject this field with INVALID_ARGUMENT.
          ...(modelSupportsThinking(env.GEMINI_MODEL)
            ? { thinkingConfig: { thinkingBudget: 0 } }
            : {}),
        },
      }),
      timeoutPromise,
    ]);

    return response.text ?? '';
  } finally {
    cancel();
  }
}

/**
 * Runs one structured-output request.
 *
 * Returns `{ ok: false, reason }` for every failure mode — no key, transport
 * error, timeout, empty response, unparseable JSON — so no caller has to
 * try/catch and no malformed output can reach the database.
 *
 * Each attempt waits for a slot from `llmRateLimiter` first. A 429 is recorded
 * on the limiter (pausing every other caller for the provider's cool-down) and
 * reported back as `rateLimited` with the wait the provider asked for. Callers
 * that pass `maxAttempts: 1` get that report instead of an in-process sleep.
 */
export async function generateStructured<T>(
  request: StructuredRequest,
): Promise<StructuredResult<T>> {
  const client = getClient();

  if (client === null) {
    return { ok: false, reason: 'LLM not configured (GEMINI_API_KEY is not set)' };
  }

  const timeoutMs = request.timeoutMs ?? env.LLM_TIMEOUT_MS;
  const maxAttempts = Math.max(1, request.maxAttempts ?? MAX_ATTEMPTS);
  let lastFailure: StructuredResult<T> = { ok: false, reason: 'unknown LLM failure' };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let raw: string;

    // Throttle before the request rather than after being refused.
    const release = await llmRateLimiter.acquire();

    try {
      raw = await callProvider(client, request, timeoutMs);
    } catch (error: unknown) {
      const rateLimited = isRateLimitError(error);
      const retryAfterMs = rateLimited ? parseRetryDelayMs(error) : null;

      if (rateLimited) {
        // Hold every other caller back too: the quota is per key, not per call.
        llmRateLimiter.noteRateLimit(retryAfterMs ?? DEFAULT_RETRY_DELAY_MS);
      }

      lastFailure = {
        ok: false,
        reason: `LLM request failed: ${errorText(error)}`,
        ...(rateLimited ? { rateLimited: true } : {}),
        ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      };

      if (attempt < maxAttempts) {
        if (rateLimited) {
          const waitMs = extractRetryDelayMs(error);
          logger.info(
            `[llm] attempt ${attempt} hit rate limit — waiting ${Math.round(waitMs / 1000)}s before retry`,
          );
          await delay(waitMs);
        } else {
          // Transient error: short backoff, then retry.
          logger.debug(`[llm] attempt ${attempt} failed (${lastFailure.reason}) — retrying`);
          await delay(DEFAULT_RETRY_DELAY_MS);
        }
        continue;
      }
      return lastFailure;
    } finally {
      release();
    }

    const text = stripCodeFence(raw);

    if (text.length === 0) {
      lastFailure = { ok: false, reason: 'LLM returned an empty response' };
      if (attempt < maxAttempts) {
        await delay(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      return lastFailure;
    }

    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch {
      // Schema-enforced output should always parse; a malformed body is not
      // worth a second call, and it must never be stored.
      return { ok: false, reason: 'LLM returned unparseable JSON' };
    }
  }

  return lastFailure;
}
