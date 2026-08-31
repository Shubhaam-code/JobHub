import { describe, expect, it } from 'vitest';

import { buildMessageKey, computeRetryDelayMs } from '../src/queue/ingest-queue.js';

/** Fixed values so the curve under test is independent of the local .env. */
const BACKOFF = { baseMs: 5_000, maxMs: 600_000 };

describe('buildMessageKey — one identity per Telegram message', () => {
  it('prefers the numeric channel id', () => {
    expect(buildMessageKey('-1001234567890', 'jobsvillaa', 4821)).toBe('-1001234567890:4821');
  });

  it('survives a channel rename: same id, different username → same key', () => {
    expect(buildMessageKey('-1001234567890', 'jobsvillaa', 4821)).toBe(
      buildMessageKey('-1001234567890', 'jobsvillaa_official', 4821),
    );
  });

  it('falls back to the username, lowercased and without the @', () => {
    expect(buildMessageKey(null, '@Jobsvillaa', 4821)).toBe('jobsvillaa:4821');
    expect(buildMessageKey(null, '@Jobs', 7)).toBe(buildMessageKey(null, 'jobs', 7));
  });

  it('separates different messages and different channels', () => {
    expect(buildMessageKey(null, 'jobsvillaa', 4821)).not.toBe(
      buildMessageKey(null, 'jobsvillaa', 4822),
    );
    expect(buildMessageKey(null, 'channel_a', 1)).not.toBe(buildMessageKey(null, 'channel_b', 1));
  });
});

describe('computeRetryDelayMs — backoff that cannot become a tight loop', () => {
  it('doubles per attempt from the base delay', () => {
    expect(computeRetryDelayMs(1, null, BACKOFF)).toBe(5_000);
    expect(computeRetryDelayMs(2, null, BACKOFF)).toBe(10_000);
    expect(computeRetryDelayMs(3, null, BACKOFF)).toBe(20_000);
    expect(computeRetryDelayMs(4, null, BACKOFF)).toBe(40_000);
  });

  it('caps at the ceiling instead of scheduling a retry days away', () => {
    expect(computeRetryDelayMs(40, null, BACKOFF)).toBe(BACKOFF.maxMs);
    expect(computeRetryDelayMs(1_000, null, BACKOFF)).toBe(BACKOFF.maxMs);
  });

  it('honours the provider Retry-After above its own curve', () => {
    expect(computeRetryDelayMs(1, 45_000, BACKOFF)).toBe(45_000);
    // Even when the provider asks for less than the exponential step.
    expect(computeRetryDelayMs(5, 3_000, BACKOFF)).toBe(3_000);
  });

  it('still caps a Retry-After the provider inflates', () => {
    expect(computeRetryDelayMs(1, 5_000_000, BACKOFF)).toBe(BACKOFF.maxMs);
  });

  it('ignores a missing, zero or negative Retry-After', () => {
    expect(computeRetryDelayMs(2, null, BACKOFF)).toBe(10_000);
    expect(computeRetryDelayMs(2, undefined, BACKOFF)).toBe(10_000);
    expect(computeRetryDelayMs(2, 0, BACKOFF)).toBe(10_000);
    expect(computeRetryDelayMs(2, -1_000, BACKOFF)).toBe(10_000);
  });

  it('never returns a delay short enough to spin, and never shrinks', () => {
    let previous = 0;
    for (let attempt = 0; attempt <= 12; attempt += 1) {
      const delay = computeRetryDelayMs(attempt, null, BACKOFF);
      expect(delay).toBeGreaterThanOrEqual(BACKOFF.baseMs);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });

  it('uses the configured defaults when no options are passed', () => {
    // Env-driven, so assert the shape rather than the numbers.
    const first = computeRetryDelayMs(1);
    const second = computeRetryDelayMs(2);
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
