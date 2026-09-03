/**
 * Following an apply URL to where it actually lands.
 *
 * `classifyApplyUrl` can only judge the URL in front of it, so a shortener or a
 * redirect wrapper is honestly reported as `wrapper` — unknown until resolved.
 * This module does the resolving: it walks the redirect chain by hand, one hop at
 * a time, and hands back the final URL plus the chain it took.
 *
 * Manual redirects rather than `redirect: 'follow'` for two reasons. The hop chain
 * is evidence — it is written into the audit report and shown in the review queue,
 * so a human can see that `bit.ly/x` went through an aggregator before landing
 * somewhere respectable. And a loop is detected here rather than being left to the
 * runtime's own opaque cap.
 *
 * Never throws. Every failure — timeout, DNS, TLS, 500, a loop, a hop limit — comes
 * back as `ok: false` with a reason, because the caller's correct response to all of
 * them is identical: leave the stored link alone and mark it for review.
 */

import { env } from '../config/env.js';
import { normalizeApplyUrl } from './classify.js';

export interface ApplyUrlResolveResult {
  /** True when a final, non-redirecting response was reached. */
  ok: boolean;
  /** The last URL reached. Falls back to the input when nothing could be fetched. */
  finalUrl: string;
  /** Every URL visited, starting with the normalized input. */
  hops: string[];
  /** HTTP status of the final response, when there was one. */
  status?: number;
  /** Why resolution stopped short. Absent on success. */
  reason?: string;
}

/**
 * Identifies this app and links back to it, as a well-behaved fetcher should.
 * Sending no User-Agent is what most hosts refuse outright.
 */
const USER_AGENT = 'Mozilla/5.0 (compatible; JobHubBot/1.0; +https://github.com/jobhub)';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface ResolveOptions {
  /** Maximum redirects to follow. Default 5. */
  maxHops?: number;
  /** Per-request timeout in ms. Defaults to `APPLY_URL_RESOLVE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Injected in tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One request, with a hard timeout and the body discarded.
 *
 * `GET` rather than `HEAD`: plenty of ATS hosts answer `HEAD` with a 405 or a
 * misleading 404, which would report a healthy application form as broken. The
 * body is cancelled the moment the headers arrive, so a `GET` costs about the same
 * as a `HEAD` on the wire and nothing in memory.
 */
async function requestOnce(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; response: Response } | { ok: false; reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    return { ok: true, response };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `request timed out after ${String(timeoutMs)}ms`
        : `request failed: ${errorText(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Follows `url` to its final destination.
 *
 * The returned `finalUrl` is normalized, so it can be handed straight to
 * `classifyApplyUrl` and compared against a stored value without a spelling
 * difference reading as a change.
 */
export async function resolveApplyUrl(
  raw: string | null | undefined,
  options: ResolveOptions = {},
): Promise<ApplyUrlResolveResult> {
  const maxHops = options.maxHops ?? 5;
  const timeoutMs = options.timeoutMs ?? env.APPLY_URL_RESOLVE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const start = normalizeApplyUrl(raw);
  if (start === null) {
    return {
      ok: false,
      finalUrl: raw?.trim() ?? '',
      hops: [],
      reason: 'not a usable http(s) URL',
    };
  }

  const hops: string[] = [start];
  const seen = new Set<string>([start]);
  let current = start;

  for (let hop = 0; hop <= maxHops; hop += 1) {
    const attempt = await requestOnce(current, timeoutMs, fetchImpl);

    if (!attempt.ok) {
      return { ok: false, finalUrl: current, hops, reason: attempt.reason };
    }

    const { response } = attempt;
    // The body is never read — only the status and `location` matter here.
    await response.body?.cancel().catch(() => undefined);

    if (!REDIRECT_STATUSES.has(response.status)) {
      return {
        ok: response.ok,
        finalUrl: current,
        hops,
        status: response.status,
        ...(response.ok ? {} : { reason: `final response was ${String(response.status)}` }),
      };
    }

    const location = response.headers.get('location');
    if (location === null || location.trim().length === 0) {
      return {
        ok: false,
        finalUrl: current,
        hops,
        status: response.status,
        reason: `${String(response.status)} with no Location header`,
      };
    }

    // A `Location` is allowed to be relative, so it is resolved against the URL
    // that produced it before being normalized.
    let next: string | null;
    try {
      next = normalizeApplyUrl(new URL(location, current).toString());
    } catch {
      next = null;
    }

    if (next === null) {
      return {
        ok: false,
        finalUrl: current,
        hops,
        status: response.status,
        reason: `redirect to an unusable URL (${location})`,
      };
    }

    if (seen.has(next)) {
      return { ok: false, finalUrl: current, hops, reason: 'redirect loop' };
    }

    if (hop === maxHops) {
      return {
        ok: false,
        finalUrl: current,
        hops,
        reason: `more than ${String(maxHops)} redirects`,
      };
    }

    seen.add(next);
    hops.push(next);
    current = next;
  }

  // Unreachable: the loop always returns. Present so the function is total.
  return { ok: false, finalUrl: current, hops, reason: 'redirect limit reached' };
}
