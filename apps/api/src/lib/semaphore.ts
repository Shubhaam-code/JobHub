/**
 * A minimal counting semaphore with FIFO waiters.
 *
 * Used where work has to be *bounded* rather than *throttled*: the LLM rate
 * limiter in `llm/rate-limiter.ts` also enforces a requests-per-minute window
 * and a shared 429 cool-down, which is the right shape for a provider quota and
 * the wrong shape for "only N of these may be in memory at once".
 *
 * Waiters are released strictly in order and only ever by another caller's
 * release — there is no timer and no polling, so an idle semaphore costs
 * nothing and can never hold the event loop open during shutdown.
 */

export type SemaphoreRelease = () => void;

export interface Semaphore {
  /**
   * Resolves when a slot is free. The returned release **must** be called —
   * always from a `finally`, or a thrown error leaks the slot permanently.
   */
  acquire(): Promise<SemaphoreRelease>;
  /** Slots currently held. */
  readonly active: number;
  /** Callers queued behind the limit. */
  readonly waiting: number;
}

export function createSemaphore(limit: number): Semaphore {
  const max = Math.max(1, limit);
  const waiters: Array<() => void> = [];
  let active = 0;

  function next(): void {
    if (waiters.length === 0 || active >= max) return;
    const waiter = waiters.shift();
    if (waiter === undefined) return;
    active += 1;
    waiter();
  }

  return {
    acquire(): Promise<SemaphoreRelease> {
      return new Promise<SemaphoreRelease>((resolve) => {
        /* One-shot release: a handler that somehow calls it twice must not free
           a slot it does not hold, which would let the limit drift upward. */
        let released = false;
        const releaseSlot: SemaphoreRelease = () => {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
          next();
        };

        if (active < max) {
          active += 1;
          resolve(releaseSlot);
          return;
        }

        waiters.push(() => resolve(releaseSlot));
      });
    },

    get active(): number {
      return active;
    },

    get waiting(): number {
      return waiters.length;
    },
  };
}
