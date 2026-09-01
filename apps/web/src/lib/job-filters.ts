/**
 * The Jobs page filter model — one definition, shared by the sidebar, the URL and
 * the API request.
 *
 * Two groups, and only two: when a posting is dated, and what kind of work it is.
 * Every option here resolves to a real query the API can answer (`postedFrom` /
 * `postedTo` / `type` on `GET /api/v1/jobs`), so nothing in the sidebar is a
 * control that looks live and filters nothing.
 */
import type { FetchJobsParams, PublicJob } from "@/lib/api";

/**
 * Date windows, resolved against the reader's own clock.
 *
 * These are labels for boundaries computed *here*, in the browser, and sent to
 * the API as absolute instants — "Today" means the reader's today, not the
 * server's. See `resolveDateWindow`.
 */
export const DATE_POSTED_FILTERS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last-7-days", label: "Last 7 Days" },
  { id: "last-30-days", label: "Last 30 Days" },
  { id: "custom", label: "Custom Date" },
] as const;

export const JOB_TYPE_FILTERS = [
  { id: "full-time", label: "Full-time" },
  { id: "part-time", label: "Part-time" },
  { id: "remote", label: "Remote" },
  { id: "internship", label: "Internship" },
  { id: "contract", label: "Contract" },
] as const;

export type DatePostedId = (typeof DATE_POSTED_FILTERS)[number]["id"];
export type JobTypeId = (typeof JOB_TYPE_FILTERS)[number]["id"];
export type SortId = "newest" | "oldest";

const DATE_POSTED_IDS = new Set<string>(DATE_POSTED_FILTERS.map((option) => option.id));
const JOB_TYPE_IDS = new Set<string>(JOB_TYPE_FILTERS.map((option) => option.id));

/**
 * Everything the Jobs page reads from the URL.
 *
 * `datePosted` and `jobType` are nullable because a radio group starts with
 * nothing selected — that is the unfiltered feed, and it is what Reset returns
 * to. Deliberately no "Anytime" / "All types" option: the two groups hold exactly
 * the options they were specified with.
 */
export interface JobFilterState {
  search: string;
  location: string;
  datePosted: DatePostedId | null;
  /** `yyyy-mm-dd`, straight from an `<input type="date">`. Only read when `datePosted === "custom"`. */
  customFrom: string;
  customTo: string;
  jobType: JobTypeId | null;
  sort: SortId;
}

export const EMPTY_FILTERS: JobFilterState = {
  search: "",
  location: "",
  datePosted: null,
  customFrom: "",
  customTo: "",
  jobType: null,
  sort: "newest",
};

/** Accepts both `URLSearchParams` and Next's read-only wrapper around it. */
interface ReadonlyParams {
  get(name: string): string | null;
}

/** The filter state a query string describes. Unknown values fall back to unset. */
export function parseFilters(params: ReadonlyParams): JobFilterState {
  const date = params.get("date")?.trim() ?? "";
  const type = params.get("type")?.trim().toLowerCase() ?? "";
  const sort = params.get("sort")?.trim().toLowerCase() ?? "";

  return {
    search: params.get("q")?.trim() ?? "",
    location: params.get("location")?.trim() ?? "",
    datePosted: DATE_POSTED_IDS.has(date) ? (date as DatePostedId) : null,
    customFrom: normalizeDateInput(params.get("from")),
    customTo: normalizeDateInput(params.get("to")),
    jobType: JOB_TYPE_IDS.has(type) ? (type as JobTypeId) : null,
    sort: sort === "oldest" ? "oldest" : "newest",
  };
}

/**
 * The query string for a filter state — only the parts that differ from the
 * default, so an unfiltered `/jobs` stays a clean URL.
 */
export function serializeFilters(state: JobFilterState): string {
  const params = new URLSearchParams();

  if (state.search.trim()) params.set("q", state.search.trim());
  if (state.location.trim()) params.set("location", state.location.trim());
  if (state.datePosted) params.set("date", state.datePosted);
  if (state.datePosted === "custom") {
    if (state.customFrom) params.set("from", state.customFrom);
    if (state.customTo) params.set("to", state.customTo);
  }
  if (state.jobType) params.set("type", state.jobType);
  if (state.sort !== "newest") params.set("sort", state.sort);

  return params.toString();
}

/** Whether anything is narrowing the feed — what the Reset control is for. */
export function hasActiveFilters(state: JobFilterState): boolean {
  return Boolean(state.search || state.location || state.datePosted || state.jobType);
}

/** How many of the sidebar's own groups are set, for the "Filters (n)" count. */
export function activeFilterCount(state: JobFilterState): number {
  return (state.datePosted ? 1 : 0) + (state.jobType ? 1 : 0);
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** A `yyyy-mm-dd` field value, or "" for anything else. */
function normalizeDateInput(value: string | null): string {
  const text = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

/**
 * `yyyy-mm-dd` as local midnight.
 *
 * Built from the parts rather than handed to `new Date(string)`, which reads a
 * bare date as UTC midnight — that shifts the whole window by the reader's offset
 * and, east of UTC, silently drops everything posted in the first hours of the
 * day they asked for.
 */
function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);

  // Rejects an impossible date (2026-02-31) instead of letting it roll forward.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date;
}

/**
 * The `postedAt` window a date option means, as ISO instants.
 *
 * The upper bound is left open for the three "up to now" options: a listing that
 * arrived a second ago must not fall outside its own window because our clock and
 * the API's differ by a moment. Only the closed windows — yesterday, and a custom
 * range — set one.
 */
export function resolveDateWindow(
  state: JobFilterState,
  now: Date = new Date(),
): { postedFrom?: string; postedTo?: string } {
  const today = startOfDay(now);

  switch (state.datePosted) {
    case "today":
      return { postedFrom: today.toISOString() };

    case "yesterday":
      return {
        postedFrom: addDays(today, -1).toISOString(),
        postedTo: new Date(today.getTime() - 1).toISOString(),
      };

    /* Seven and thirty calendar days counting today, so "Last 7 Days" lines up
       with the dates on the cards rather than cutting mid-day a week back. */
    case "last-7-days":
      return { postedFrom: addDays(today, -6).toISOString() };

    case "last-30-days":
      return { postedFrom: addDays(today, -29).toISOString() };

    case "custom": {
      const from = parseDateInput(state.customFrom);
      const to = parseDateInput(state.customTo);
      const window: { postedFrom?: string; postedTo?: string } = {};

      if (from) window.postedFrom = from.toISOString();
      // Inclusive of the end date itself: through the last millisecond of it.
      if (to) window.postedTo = new Date(addDays(to, 1).getTime() - 1).toISOString();

      /* A range typed backwards would be a 400 from the API. Swapping it is the
         reading the user obviously meant, and keeps the page showing results. */
      if (
        window.postedFrom &&
        window.postedTo &&
        window.postedFrom > window.postedTo &&
        from &&
        to
      ) {
        return {
          postedFrom: to.toISOString(),
          postedTo: new Date(addDays(from, 1).getTime() - 1).toISOString(),
        };
      }

      return window;
    }

    default:
      return {};
  }
}

/** True once a custom window is selected but neither date has been filled in. */
export function isCustomRangeIncomplete(state: JobFilterState): boolean {
  return state.datePosted === "custom" && !state.customFrom && !state.customTo;
}

/** The request `GET /api/v1/jobs` should receive for this filter state. */
export function toFetchParams(
  state: JobFilterState,
  page: number,
  limit: number,
  now: Date = new Date(),
): FetchJobsParams {
  return {
    page,
    limit,
    sort: state.sort,
    ...(state.search.trim() ? { search: state.search.trim() } : {}),
    ...(state.location.trim() ? { location: state.location.trim() } : {}),
    ...(state.jobType ? { type: state.jobType } : {}),
    ...resolveDateWindow(state, now),
  };
}

/* ---------------------------------------------------------------------------
   The client-side twin of the server filter.

   A job arriving over the socket has not been through the query, so it is
   checked here before it can join the list. These patterns are the same ones
   `apps/api/src/routes/jobs.route.ts` uses, so a live arrival and a refetch agree
   on what belongs.
   --------------------------------------------------------------------------- */

const INTERN_ROLE_REGEX = /intern/i;
const PART_TIME_REGEX = /part[\s._-]*time/i;
const CONTRACT_REGEX = /contract|contractual|freelance/i;
const REMOTE_TYPE_REGEX = /remote|work[\s._-]*from[\s._-]*home|wfh/i;
const REMOTE_LOCATION_REGEX = /remote|work[\s._-]*from[\s._-]*home|wfh|anywhere/i;

function matchesJobType(job: PublicJob, jobType: JobTypeId): boolean {
  switch (jobType) {
    case "internship":
      return INTERN_ROLE_REGEX.test(job.role ?? "");
    case "full-time":
      return !INTERN_ROLE_REGEX.test(job.role ?? "");
    case "part-time":
      return PART_TIME_REGEX.test(job.employmentType ?? "");
    case "contract":
      return CONTRACT_REGEX.test(job.employmentType ?? "");
    case "remote":
      return (
        REMOTE_TYPE_REGEX.test(job.employmentType ?? "") ||
        REMOTE_LOCATION_REGEX.test(job.location ?? "")
      );
  }
}

export function matchesFilters(
  job: PublicJob,
  state: JobFilterState,
  now: Date = new Date(),
): boolean {
  const search = state.search.trim().toLowerCase();
  if (search) {
    const haystack = `${job.company ?? ""} ${job.role ?? ""}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }

  const location = state.location.trim().toLowerCase();
  if (location && !(job.location ?? "").toLowerCase().includes(location)) {
    return false;
  }

  if (state.jobType && !matchesJobType(job, state.jobType)) return false;

  const { postedFrom, postedTo } = resolveDateWindow(state, now);
  if (postedFrom || postedTo) {
    const postedAt = new Date(job.postedAt).getTime();
    if (Number.isNaN(postedAt)) return false;
    if (postedFrom && postedAt < new Date(postedFrom).getTime()) return false;
    if (postedTo && postedAt > new Date(postedTo).getTime()) return false;
  }

  return true;
}
