/**
 * In-session cache for the Jobs screens.
 *
 * Both the list and the detail page fetch from an effect on mount, and a client
 * component does not survive a route change — so opening a job, moving to
 * another, then coming back used to blank the page out and ask the API again for
 * a posting the reader had already been shown. This keeps the answers in module
 * scope, which a client-side navigation does not tear down, so returning to a
 * job or to a list is immediate and silent.
 *
 * Memory only, and deliberately short-lived: a reload starts from nothing, and an
 * entry older than `TTL_MS` is ignored, so once the copy on hand is too old to
 * trust the ordinary fetch — skeleton and all — runs exactly as before.
 */

import type { PublicJob } from "@/lib/api";

/**
 * How long an answer counts as fresh.
 *
 * The same window Next uses for a prefetched static segment, and the same bet: a
 * posting does not change in the minutes a reader spends moving around it.
 */
const TTL_MS = 5 * 60 * 1000;

/** Caps on how much a long browsing session may retain. */
const MAX_JOBS = 60;
const MAX_LISTS = 12;

/** Everything `JobsList` needs to put a loaded list back exactly as it was. */
export interface CachedJobsList {
  jobs: PublicJob[];
  /** Last page infinite scroll appended, so scrolling resumes from there. */
  page: number;
  total: number;
  totalPages: number;
  /** Socket arrivals already counted into the visible total. */
  liveAdded: number;
  /**
   * When the API answered for this query.
   *
   * Carried in the snapshot rather than stamped on write, because appending a
   * batch or taking a live arrival updates the entry without re-asking the API:
   * renewing the clock there would mean a list a reader keeps returning to never
   * goes stale.
   */
  loadedAt: number;
}

const jobs = new Map<string, { job: PublicJob; loadedAt: number }>();
const lists = new Map<string, CachedJobsList>();

function isFresh(loadedAt: number): boolean {
  return Date.now() - loadedAt <= TTL_MS;
}

/**
 * Drops the oldest entries once a store is over its cap.
 *
 * A Map iterates in insertion order and every write below re-inserts its key, so
 * the front of the store is the least recently written.
 */
function evict<V>(store: Map<string, V>, max: number): void {
  while (store.size > max) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** The job as last loaded, or null when it was never loaded or has gone stale. */
export function readCachedJob(id: string): PublicJob | null {
  const entry = jobs.get(id);
  return entry && isFresh(entry.loadedAt) ? entry.job : null;
}

export function cacheJob(job: PublicJob): void {
  jobs.delete(job.id);
  jobs.set(job.id, { job, loadedAt: Date.now() });
  evict(jobs, MAX_JOBS);
}

/** The list as last shown for these exact filters, or null when stale/absent. */
export function readCachedJobsList(query: string): CachedJobsList | null {
  const entry = lists.get(query);
  return entry && isFresh(entry.loadedAt) ? entry : null;
}

export function cacheJobsList(query: string, list: CachedJobsList): void {
  lists.delete(query);
  lists.set(query, list);
  evict(lists, MAX_LISTS);
}
