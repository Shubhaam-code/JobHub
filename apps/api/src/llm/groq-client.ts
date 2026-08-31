/**
 * Minimal Groq provider wrapper, used only by resume parsing.
 *
 * Same contract as `llm/client.ts`: given a system instruction, a prompt and a
 * JSON schema, return parsed JSON that conforms to the schema — or a reason why
 * it could not. Groq speaks the OpenAI chat-completions shape, so this is one
 * `fetch` against `/openai/v1/chat/completions` with structured outputs turned
 * on; no SDK is needed.
 *
 * Deliberately separate from the Gemini client rather than folded into it:
 * classification (Gemini) and resume parsing (Groq) use different keys with
 * different quotas, so they must not share a throttle or a cached client.
 *
 * The key is read from the server environment and never leaves this module — it
 * only ever appears in the outbound Authorization header.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { JsonSchema, StructuredResult, StructuredRequest } from './client.js';

const GROQ_CHAT_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * One retry, and only for a failure that could plausibly succeed on a second
 * try (network blip, 5xx, timeout). A resume upload is a user waiting on an
 * HTTP response, so a long retry ladder would just turn a failure into a hang.
 */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_000;
const MAX_OUTPUT_TOKENS = 512;

/** Cap on provider error text kept in a reason string, so logs stay readable. */
const MAX_ERROR_CHARS = 400;

/**
 * True for the gpt-oss family, the only models here that accept
 * `reasoning_effort`. Sending it to any other model is a 400, so it is gated —
 * and it matters, because reasoning tokens are billed against
 * `max_completion_tokens` and would otherwise truncate the JSON mid-object.
 */
function modelSupportsReasoningEffort(modelName: string): boolean {
  return /^(?:openai\/)?gpt-oss/i.test(modelName);
}

/** True when a Groq key is configured, i.e. resume parsing can run at all. */
export function isGroqConfigured(): boolean {
  return env.GROQ_API_KEY !== undefined;
}

/** Model id in use — safe to log (never a key). */
export function groqModelName(): string {
  return env.GROQ_MODEL;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text: string): string {
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

/**
 * Strips a ```json fence when a model wraps its JSON despite structured output
 * being requested. Cheap tolerance, not free-form parsing.
 */
function stripCodeFence(raw: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(raw);
  return (fenced?.[1] ?? raw).trim();
}

/**
 * Reads Groq's `Retry-After` header, in milliseconds, or null when it gave none.
 * A 1s buffer is added so the retry lands just after the window opens rather
 * than exactly on the boundary, where it would be refused again.
 */
export function parseGroqRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;

  const seconds = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(header)?.[1];
  if (seconds !== undefined) {
    return Math.ceil(parseFloat(seconds) * 1000) + 1_000;
  }

  return null;
}

/** Groq's slice of the OpenAI chat-completions response. Everything else is ignored. */
interface GroqChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

interface AttemptFailure {
  reason: string;
  /** True when the failure is transient, i.e. worth one more attempt. */
  retryable: boolean;
  rateLimited?: boolean;
  retryAfterMs?: number;
}

type Attempt = { ok: true; text: string } | ({ ok: false } & AttemptFailure);

/**
 * One HTTP call to Groq. Returns the raw assistant text, or a classified
 * failure — this function never throws.
 */
async function callGroq(
  apiKey: string,
  request: StructuredRequest,
  schema: JsonSchema,
  timeoutMs: number,
): Promise<Attempt> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        temperature: 0,
        max_completion_tokens: request.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
        messages: [
          { role: 'system', content: request.systemInstruction },
          { role: 'user', content: request.prompt },
        ],
        // Extraction is a lookup, not a puzzle: minimal reasoning keeps the
        // token budget for the answer. Only gpt-oss accepts this field.
        ...(modelSupportsReasoningEffort(env.GROQ_MODEL) ? { reasoning_effort: 'low' } : {}),
        // Constrained decoding: the model cannot answer with a shape the parser
        // would have to reject. `strict` needs a closed schema with every
        // property required, which the resume schema already is.
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'structured_output', strict: true, schema },
        },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Body is the provider's error message; read it so the reason is useful.
      const body = truncate(await response.text().catch(() => ''));
      const rateLimited = response.status === 429;
      const retryAfterMs = rateLimited
        ? parseGroqRetryAfterMs(response.headers.get('retry-after'))
        : null;

      return {
        ok: false,
        reason: `Groq request failed with ${String(response.status)}: ${body}`,
        // A 429 is reported rather than slept through: the caller is an HTTP
        // request, and the existing "busy, try again" state is the right answer.
        retryable: response.status >= 500,
        ...(rateLimited ? { rateLimited: true } : {}),
        ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      };
    }

    const payload = (await response.json()) as GroqChatResponse;
    const text = payload.choices?.[0]?.message?.content ?? '';

    return { ok: true, text };
  } catch (error: unknown) {
    const aborted = controller.signal.aborted;

    return {
      ok: false,
      reason: aborted
        ? `Groq call timed out after ${String(timeoutMs)}ms`
        : `Groq request failed: ${errorText(error)}`,
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs one structured-output request against Groq.
 *
 * Returns `{ ok: false, reason }` for every failure mode — no key, transport
 * error, timeout, non-2xx, empty response, unparseable JSON — so no caller has
 * to try/catch and no malformed output can reach the database.
 */
export async function generateStructuredWithGroq<T>(
  request: StructuredRequest,
): Promise<StructuredResult<T>> {
  const apiKey = env.GROQ_API_KEY;

  if (apiKey === undefined) {
    return { ok: false, reason: 'LLM not configured (GROQ_API_KEY is not set)' };
  }

  const timeoutMs = request.timeoutMs ?? env.LLM_TIMEOUT_MS;
  const maxAttempts = Math.max(1, request.maxAttempts ?? MAX_ATTEMPTS);
  let lastFailure: StructuredResult<T> = { ok: false, reason: 'unknown Groq failure' };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await callGroq(apiKey, request, request.schema, timeoutMs);

    if (!result.ok) {
      lastFailure = {
        ok: false,
        reason: result.reason,
        ...(result.rateLimited === true ? { rateLimited: true } : {}),
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      };

      if (result.retryable && attempt < maxAttempts) {
        logger.debug(`[groq] attempt ${String(attempt)} failed (${result.reason}) — retrying`);
        await delay(RETRY_DELAY_MS);
        continue;
      }

      return lastFailure;
    }

    const text = stripCodeFence(result.text);

    if (text.length === 0) {
      lastFailure = { ok: false, reason: 'Groq returned an empty response' };
      if (attempt < maxAttempts) {
        await delay(RETRY_DELAY_MS);
        continue;
      }
      return lastFailure;
    }

    try {
      return { ok: true, data: JSON.parse(text) as T };
    } catch {
      // Schema-constrained output should always parse; a malformed body is not
      // worth a second call, and it must never be stored.
      return { ok: false, reason: 'Groq returned unparseable JSON' };
    }
  }

  return lastFailure;
}
