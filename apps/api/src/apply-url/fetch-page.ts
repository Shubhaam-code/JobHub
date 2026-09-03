/**
 * Reading one aggregator article page, safely.
 *
 * Split out from the candidate scoring so that scoring stays pure and testable
 * against saved HTML, and so every fetch in this feature shares one set of limits:
 * a hard timeout, a byte cap on the body, and an honest User-Agent.
 *
 * The byte cap matters more than it looks. The worker's memory guarantee is "at
 * most `QUEUE_CONCURRENCY` messages resident", and an unbounded `response.text()`
 * against an arbitrary third-party host would quietly void it. A truncated tail
 * costs nothing here: the apply link sits in the article, far above the cap.
 *
 * Never throws — every failure is a reason string, because the caller's response to
 * all of them is the same: leave the stored link alone.
 */

import { env } from '../config/env.js';

/** Cap on HTML read per page. An article is a few hundred KB; this is the roof. */
const MAX_HTML_BYTES = 2_000_000;

const USER_AGENT = 'Mozilla/5.0 (compatible; JobHubBot/1.0; +https://github.com/jobhub)';

export type FetchPageResult = { ok: true; html: string } | { ok: false; reason: string };

export interface FetchPageOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Reads the response body, stopping at `MAX_HTML_BYTES`. */
async function readCappedText(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let text = '';
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;

      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });

      if (bytes >= MAX_HTML_BYTES) break;
    }
  } finally {
    // Also releases the socket when the loop stopped at the cap or threw.
    await reader.cancel().catch(() => undefined);
  }

  return text;
}

/** Fetches one HTML page. Follows redirects — the page itself is the target here. */
export async function fetchPageHtml(
  pageUrl: string,
  options: FetchPageOptions = {},
): Promise<FetchPageResult> {
  const timeoutMs = options.timeoutMs ?? env.APPLY_URL_RESOLVE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(pageUrl, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `page returned ${String(response.status)}` };
    }

    // Absent is accepted — plenty of hosts omit it — but an explicit non-HTML type
    // (a PDF, an image) is not worth reading.
    const contentType = response.headers.get('content-type');
    if (contentType !== null && !/html/i.test(contentType)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `page is not html (${contentType})` };
    }

    return { ok: true, html: await readCappedText(response) };
  } catch (error: unknown) {
    return {
      ok: false,
      reason: controller.signal.aborted
        ? `page fetch timed out after ${String(timeoutMs)}ms`
        : `page fetch failed: ${errorText(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
