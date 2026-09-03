import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isRateLimitError, parseRetryDelayMs } from '../src/llm/client.js';
import { createRateLimiter } from '../src/llm/rate-limiter.js';

/** Flushes queued microtasks so a resolved acquire() has run its `.then`. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('createRateLimiter — proactive throttle in front of the provider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never allows more calls in flight than the configured concurrency', async () => {
    const clock = 0;
    const limiter = createRateLimiter({
      maxRequestsPerMinute: 1_000,
      concurrency: 2,
      now: () => clock,
    });

    const first = await limiter.acquire();
    const second = await limiter.acquire();

    let thirdGranted = false;
    const third = limiter.acquire().then((release) => {
      thirdGranted = true;
      return release;
    });

    await settle();
    expect(thirdGranted).toBe(false);
    expect(limiter.stats()).toMatchObject({ inFlight: 2, waiting: 1 });

    // A finished call hands its slot to the queued one, in FIFO order.
    first();
    await expect(third).resolves.toBeTypeOf('function');
    expect(limiter.stats()).toMatchObject({ inFlight: 2, waiting: 0 });

    second();
    (await third)();
    expect(limiter.stats().inFlight).toBe(0);
  });

  it('holds calls back once the per-minute ceiling is reached', async () => {
    let clock = 1_000_000;
    const limiter = createRateLimiter({
      maxRequestsPerMinute: 2,
      concurrency: 5,
      now: () => clock,
    });

    // Released immediately: the rolling window is the binding limit here, not
    // concurrency, so a finished call does not free up quota.
    (await limiter.acquire())();
    (await limiter.acquire())();

    let granted = false;
    const third = limiter.acquire().then((release) => {
      granted = true;
      return release;
    });

    await settle();
    expect(granted).toBe(false);
    expect(limiter.stats().requestsInWindow).toBe(2);

    // Half a minute is not enough...
    clock += 30_000;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(granted).toBe(false);

    // ...but once the oldest request ages out of the rolling minute it starts.
    clock += 31_000;
    await vi.advanceTimersByTimeAsync(31_000);
    await third;
    expect(granted).toBe(true);
  });

  it('pauses every caller after a 429 for as long as the provider asked', async () => {
    let clock = 0;
    const limiter = createRateLimiter({
      maxRequestsPerMinute: 100,
      concurrency: 4,
      now: () => clock,
    });

    limiter.noteRateLimit(30_000);
    expect(limiter.cooldownRemainingMs()).toBe(30_000);
    expect(limiter.stats().cooldownUntil).toBe(30_000);

    let granted = false;
    const call = limiter.acquire().then((release) => {
      granted = true;
      return release;
    });

    await settle();
    expect(granted).toBe(false);

    clock += 30_001;
    await vi.advanceTimersByTimeAsync(30_001);
    await call;
    expect(granted).toBe(true);
    expect(limiter.cooldownRemainingMs()).toBe(0);
    expect(limiter.stats().cooldownUntil).toBeNull();
  });

  it('extends a cool-down but never shortens one', () => {
    let clock = 0;
    const limiter = createRateLimiter({
      maxRequestsPerMinute: 100,
      concurrency: 1,
      now: () => clock,
    });

    limiter.noteRateLimit(60_000);
    // A second 429 asking for less must not release the first one early.
    limiter.noteRateLimit(5_000);
    expect(limiter.cooldownRemainingMs()).toBe(60_000);

    limiter.noteRateLimit(90_000);
    expect(limiter.cooldownRemainingMs()).toBe(90_000);

    clock += 90_000;
    expect(limiter.cooldownRemainingMs()).toBe(0);
  });

  it('reset() clears the window, the cool-down and the waiters', async () => {
    const clock = 0;
    const limiter = createRateLimiter({
      maxRequestsPerMinute: 1,
      concurrency: 1,
      now: () => clock,
    });

    await limiter.acquire();
    limiter.noteRateLimit(60_000);
    void limiter.acquire();
    await settle();
    expect(limiter.stats().waiting).toBe(1);

    limiter.reset();

    expect(limiter.cooldownRemainingMs()).toBe(0);
    expect(limiter.stats()).toEqual({
      inFlight: 0,
      waiting: 0,
      requestsInWindow: 0,
      cooldownUntil: null,
    });
  });

  it('treats a zero ceiling as one request rather than deadlocking', async () => {
    const clock = 0;
    const limiter = createRateLimiter({
      maxRequestsPerMinute: 0,
      concurrency: 0,
      now: () => clock,
    });

    await expect(limiter.acquire()).resolves.toBeTypeOf('function');
  });
});

describe('isRateLimitError — a 429 must be recognised, whatever shape it arrives in', () => {
  it('detects Gemini RESOURCE_EXHAUSTED and bare 429s', () => {
    expect(isRateLimitError(new Error('{"error":{"code":429,"message":"Quota exceeded"}}'))).toBe(
      true,
    );
    expect(isRateLimitError(new Error('{"error":{"status":"RESOURCE_EXHAUSTED"}}'))).toBe(true);
    expect(isRateLimitError(new Error('Request failed with status 429'))).toBe(true);
    expect(isRateLimitError(new Error('rate limit exceeded for this key'))).toBe(true);
    expect(isRateLimitError('429 Too Many Requests')).toBe(true);
  });

  it('does not mistake other failures for a rate limit', () => {
    expect(isRateLimitError(new Error('ECONNRESET'))).toBe(false);
    expect(isRateLimitError(new Error('LLM call timed out after 20000ms'))).toBe(false);
    expect(isRateLimitError(new Error('{"error":{"code":500}}'))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });
});

describe('parseRetryDelayMs — wait exactly as long as the provider asked', () => {
  it('reads Gemini RetryInfo, plus a 1s buffer past the boundary', () => {
    expect(parseRetryDelayMs(new Error('{"retryDelay": "59s"}'))).toBe(60_000);
    expect(parseRetryDelayMs(new Error('{"retryDelay": "1.5s"}'))).toBe(2_500);
  });

  it('reads an HTTP Retry-After given in seconds', () => {
    expect(parseRetryDelayMs(new Error('retry-after: 30'))).toBe(31_000);
    expect(parseRetryDelayMs(new Error('Retry_After = "12"'))).toBe(13_000);
  });

  it('reads an HTTP Retry-After given as a date', () => {
    const target = Date.parse('Wed, 21 Oct 2030 07:28:00 GMT');
    expect(
      parseRetryDelayMs(new Error('retry-after="Wed, 21 Oct 2030 07:28:00 GMT"'), target - 20_000),
    ).toBe(21_000);
  });

  it('returns null when the provider gave no usable wait', () => {
    expect(parseRetryDelayMs(new Error('Quota exceeded'))).toBeNull();
    // A date already in the past tells us nothing about when the window reopens.
    expect(parseRetryDelayMs(new Error('retry-after="Wed, 21 Oct 2020 07:28:00 GMT"'))).toBeNull();
  });
});
