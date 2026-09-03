/**
 * Redirect resolution, and the combined classify-then-resolve entry point.
 *
 * `fetch` is injected rather than stubbed globally, so each test states exactly
 * which requests it expects. Two properties matter most:
 *
 *  - resolution **never throws**. A timeout, a loop, a 500 and a dead host all come
 *    back as `ok: false` with a reason, because the caller's response to each is the
 *    same: leave the stored link alone.
 *  - an unresolved wrapper is **never** upgraded to `direct`. A shortener hiding an
 *    aggregator is the exact case this feature exists to catch, so failing to look
 *    behind one must not read as success.
 */

import { describe, expect, it, vi } from 'vitest';

import { classifyAndResolveApplyUrl } from '../src/apply-url/index.js';
import { resolveApplyUrl } from '../src/apply-url/resolve.js';

const ATS_URL = 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/R-991';
const AGGREGATOR_URL = 'https://freshershunt.in/cognizant-off-campus-2026';

/** A redirect response carrying `location`. */
function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

function ok(status = 200): Response {
  return new Response('<html><body>ok</body></html>', {
    status,
    headers: { 'content-type': 'text/html' },
  });
}

/** A fetch stub that answers from a URL → Response map, in order of arrival. */
function fetchFrom(map: Record<string, Response | (() => Response)>): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = map[url];
    if (entry === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve(typeof entry === 'function' ? entry() : entry);
  }) as unknown as typeof fetch;
}

describe('resolveApplyUrl', () => {
  it('returns the input when there is no redirect', async () => {
    const result = await resolveApplyUrl(ATS_URL, { fetchImpl: fetchFrom({ [ATS_URL]: ok() }) });

    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe(ATS_URL);
    expect(result.hops).toEqual([ATS_URL]);
    expect(result.status).toBe(200);
  });

  it('follows a chain and records every hop as evidence', async () => {
    const mid = 'https://pdlink.in/AbCd12';
    const result = await resolveApplyUrl('https://bit.ly/3xYzAbc', {
      fetchImpl: fetchFrom({
        'https://bit.ly/3xYzAbc': redirect(mid, 301),
        [mid]: redirect(ATS_URL, 302),
        [ATS_URL]: ok(),
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe(ATS_URL);
    expect(result.hops).toEqual(['https://bit.ly/3xYzAbc', mid, ATS_URL]);
  });

  it('resolves a relative Location against the URL that produced it', async () => {
    const result = await resolveApplyUrl('https://careers.acme.com/old', {
      fetchImpl: fetchFrom({
        'https://careers.acme.com/old': redirect('/jobs/12'),
        'https://careers.acme.com/jobs/12': ok(),
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.finalUrl).toBe('https://careers.acme.com/jobs/12');
  });

  it('detects a redirect loop instead of spinning', async () => {
    const a = 'https://a.test/x';
    const b = 'https://b.test/y';
    const result = await resolveApplyUrl(a, {
      fetchImpl: fetchFrom({ [a]: () => redirect(b), [b]: () => redirect(a) }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/loop/i);
  });

  it('stops at the hop cap', async () => {
    // Each hop points at a fresh URL, so only the cap can end this.
    const fetchImpl = vi.fn((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      const n = Number(/(\d+)$/.exec(url)?.[1] ?? '0');
      return Promise.resolve(redirect(`https://hop.test/${String(n + 1)}`));
    }) as unknown as typeof fetch;

    const result = await resolveApplyUrl('https://hop.test/0', { fetchImpl, maxHops: 3 });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/more than 3 redirects/);
    expect(result.hops).toHaveLength(4);
  });

  it('reports a 4xx/5xx final response without throwing', async () => {
    const result = await resolveApplyUrl(ATS_URL, {
      fetchImpl: fetchFrom({ [ATS_URL]: ok(404) }),
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.reason).toMatch(/404/);
  });

  it('reports a redirect with no Location header', async () => {
    const result = await resolveApplyUrl(ATS_URL, {
      fetchImpl: fetchFrom({ [ATS_URL]: new Response(null, { status: 302 }) }),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/no Location/i);
  });

  it('reports a network failure as a reason rather than throwing', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND')),
    ) as unknown as typeof fetch;

    const result = await resolveApplyUrl(ATS_URL, { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ENOTFOUND/);
  });

  it('times out rather than hanging', async () => {
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;

    const result = await resolveApplyUrl(ATS_URL, { fetchImpl, timeoutMs: 20 });

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timed out/i);
  });

  it('never fetches an unusable URL', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await resolveApplyUrl('javascript:alert(1)', { fetchImpl });

    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('classifyAndResolveApplyUrl', () => {
  it('spends no request on a URL that can be judged as it stands', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    for (const url of [ATS_URL, AGGREGATOR_URL, 'https://careers.acme.com/job/1', '']) {
      const result = await classifyAndResolveApplyUrl(url, { fetchImpl, company: 'Acme' });
      expect(result.verdict).not.toBe('wrapper');
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a shortener that resolves to a trusted ATS', async () => {
    const result = await classifyAndResolveApplyUrl('https://bit.ly/3xYzAbc', {
      fetchImpl: fetchFrom({
        'https://bit.ly/3xYzAbc': redirect(ATS_URL),
        [ATS_URL]: ok(),
      }),
    });

    expect(result.verdict).toBe('direct');
    expect(result.finalUrl).toBe(ATS_URL);
    expect(result.hops).toEqual(['https://bit.ly/3xYzAbc', ATS_URL]);
  });

  it('rejects a shortener that resolves to an aggregator', async () => {
    const result = await classifyAndResolveApplyUrl('https://bit.ly/3xYzAbc', {
      fetchImpl: fetchFrom({
        'https://bit.ly/3xYzAbc': redirect(AGGREGATOR_URL),
        [AGGREGATOR_URL]: ok(),
      }),
    });

    expect(result.verdict).toBe('aggregator');
    expect(result.finalUrl).toBe(AGGREGATOR_URL);
  });

  it('resolves the placement shortener seen in our own data', async () => {
    const result = await classifyAndResolveApplyUrl('https://pdlink.in/AbCd12', {
      fetchImpl: fetchFrom({
        'https://pdlink.in/AbCd12': redirect('https://placementdrive.in/tcs-off-campus-2026/'),
        'https://placementdrive.in/tcs-off-campus-2026': ok(),
      }),
    });

    expect(result.verdict).toBe('aggregator');
  });

  it('downgrades an unresolvable wrapper to suspicious, never direct', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('socket hang up')),
    ) as unknown as typeof fetch;

    const result = await classifyAndResolveApplyUrl('https://bit.ly/3xYzAbc', { fetchImpl });

    expect(result.verdict).toBe('suspicious');
    expect(result.reason).toMatch(/unresolved redirect wrapper/i);
  });

  it('reports a wrapper that only leads to another wrapper as suspicious', async () => {
    const result = await classifyAndResolveApplyUrl('https://bit.ly/3xYzAbc', {
      fetchImpl: fetchFrom({
        'https://bit.ly/3xYzAbc': redirect('https://tinyurl.com/abcd'),
        'https://tinyurl.com/abcd': ok(),
      }),
    });

    expect(result.verdict).toBe('suspicious');
    expect(result.reason).toMatch(/another wrapper/i);
  });
});
