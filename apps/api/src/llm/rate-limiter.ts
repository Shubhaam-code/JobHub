/**
 * Proactive throttle in front of the LLM provider.
 *
 * The queue can absorb a 429, but the cheapest 429 is the one never sent. Every
 * LLM call passes through here first, which enforces three things:
 *
 *  - a rolling requests-per-minute ceiling (`LLM_MAX_REQUESTS_PER_MINUTE`),
 *  - a maximum number of in-flight calls (`LLM_CONCURRENCY`; 1 = strictly serial),
 *  - a shared cool-down after a 429, so one rate-limited call pauses all of them
 *    instead of every worker discovering the limit independently.
 *
 * Waiters are released in FIFO order and always via a timer — no polling loop,
 * no busy-wait.
 */

import { env } from '../config/env.js';

export interface RateLimiterOptions {
  maxRequestsPerMinute: number;
  concurrency: number;
  /** Injectable clock; tests pass a fake. */
  now?: () => number;
}

export interface RateLimiterStats {
  inFlight: number;
  waiting: number;
  requestsInWindow: number;
  /** Epoch ms until which all calls are paused by a 429, else null. */
  cooldownUntil: number | null;
}

/** Released when the caller's LLM request finishes. */
export type RateLimiterRelease = () => void;

export interface RateLimiter {
  /** Resolves when it is this caller's turn. Always release the result. */
  acquire(): Promise<RateLimiterRelease>;
  /** Records a 429 so every caller waits out the provider's cool-down. */
  noteRateLimit(retryAfterMs: number): void;
  /** Remaining cool-down in ms, 0 when not rate limited. */
  cooldownRemainingMs(): number;
  stats(): RateLimiterStats;
  /** Test seam: clears window, cool-down and waiters. */
  reset(): void;
}

const WINDOW_MS = 60_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const now = options.now ?? (() => Date.now());
  const maxPerMinute = Math.max(1, options.maxRequestsPerMinute);
  const concurrency = Math.max(1, options.concurrency);

  /** Start times of requests inside the current rolling window, oldest first. */
  let window: number[] = [];
  let inFlight = 0;
  let cooldownUntil = 0;
  let timer: NodeJS.Timeout | null = null;
  const waiters: Array<(release: RateLimiterRelease) => void> = [];

  function dropExpired(current: number): void {
    const cutoff = current - WINDOW_MS;
    while (window.length > 0 && window[0]! <= cutoff) {
      window.shift();
    }
  }

  /**
   * Epoch ms at which the next request may start, or null when a slot is free
   * right now. Returns the later of the 429 cool-down and the RPM window.
   */
  function nextAvailableAt(current: number): number | null {
    dropExpired(current);

    let readyAt: number | null = null;

    if (cooldownUntil > current) readyAt = cooldownUntil;

    if (window.length >= maxPerMinute) {
      // The oldest request must age out of the window before another can start.
      const windowReadyAt = window[0]! + WINDOW_MS;
      readyAt = readyAt === null ? windowReadyAt : Math.max(readyAt, windowReadyAt);
    }

    return readyAt;
  }

  function release(): void {
    inFlight = Math.max(0, inFlight - 1);
    pump();
  }

  function pump(): void {
    while (waiters.length > 0 && inFlight < concurrency) {
      const current = now();
      const readyAt = nextAvailableAt(current);

      if (readyAt !== null) {
        schedule(readyAt - current);
        return;
      }

      const waiter = waiters.shift()!;
      window.push(current);
      inFlight += 1;
      waiter(release);
    }
  }

  /** Arms a single timer for the earliest moment work can resume. */
  function schedule(delayMs: number): void {
    if (timer !== null) return;
    timer = setTimeout(
      () => {
        timer = null;
        pump();
      },
      Math.max(1, Math.ceil(delayMs)),
    );
    // Never hold the process open just to wake a throttled caller.
    timer.unref?.();
  }

  return {
    acquire(): Promise<RateLimiterRelease> {
      return new Promise<RateLimiterRelease>((resolve) => {
        waiters.push(resolve);
        pump();
      });
    },

    noteRateLimit(retryAfterMs: number): void {
      const until = now() + Math.max(0, retryAfterMs);
      if (until > cooldownUntil) cooldownUntil = until;
    },

    cooldownRemainingMs(): number {
      return Math.max(0, cooldownUntil - now());
    },

    stats(): RateLimiterStats {
      const current = now();
      dropExpired(current);
      return {
        inFlight,
        waiting: waiters.length,
        requestsInWindow: window.length,
        cooldownUntil: cooldownUntil > current ? cooldownUntil : null,
      };
    },

    reset(): void {
      window = [];
      inFlight = 0;
      cooldownUntil = 0;
      waiters.length = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

/** Process-wide limiter used by the LLM client. */
export const llmRateLimiter: RateLimiter = createRateLimiter({
  maxRequestsPerMinute: env.LLM_MAX_REQUESTS_PER_MINUTE,
  concurrency: env.LLM_CONCURRENCY,
});
