/**
 * Global Internships filter model - simplified from job-filters since all are internships
 * Only date filtering is needed here
 */
import type { FetchJobsParams, PublicJob } from "@/lib/api";

/**
 * How far back the feed reaches, matching `GITHUB_ACTIVE_WINDOW_DAYS` on the API.
 * Used to bound the date picker; the server clamps regardless, so a mismatch
 * costs an empty page rather than wrong data.
 */
export const ACTIVE_WINDOW_DAYS = 21;

export const DATE_POSTED_FILTERS = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last-7-days", label: "Last 7 Days" },
  { id: "last-21-days", label: "Last 21 Days" },
  { id: "custom", label: "Pick a date" },
] as const;

export type DatePostedId = (typeof DATE_POSTED_FILTERS)[number]["id"];
export type SortId = "newest" | "oldest";

const DATE_POSTED_IDS = new Set<string>(DATE_POSTED_FILTERS.map((option) => option.id));

export interface GlobalInternshipFilterState {
  search: string;
  location: string;
  datePosted: DatePostedId | null;
  customFrom: string;
  customTo: string;
  sort: SortId;
}

export const EMPTY_FILTERS: GlobalInternshipFilterState = {
  search: "",
  location: "",
  datePosted: null,
  customFrom: "",
  customTo: "",
  sort: "newest",
};

interface ReadonlyParams {
  get(name: string): string | null;
}

export function parseFilters(params: ReadonlyParams): GlobalInternshipFilterState {
  const date = params.get("date")?.trim() ?? "";
  const sort = params.get("sort")?.trim().toLowerCase() ?? "";

  return {
    search: params.get("q")?.trim() ?? "",
    location: params.get("location")?.trim() ?? "",
    datePosted: DATE_POSTED_IDS.has(date) ? (date as DatePostedId) : null,
    customFrom: normalizeDateInput(params.get("from")),
    customTo: normalizeDateInput(params.get("to")),
    sort: sort === "oldest" ? "oldest" : "newest",
  };
}

export function serializeFilters(state: GlobalInternshipFilterState): string {
  const params = new URLSearchParams();

  if (state.search.trim()) params.set("q", state.search.trim());
  if (state.location.trim()) params.set("location", state.location.trim());
  if (state.datePosted) params.set("date", state.datePosted);
  if (state.datePosted === "custom") {
    if (state.customFrom) params.set("from", state.customFrom);
    if (state.customTo) params.set("to", state.customTo);
  }
  if (state.sort !== "newest") params.set("sort", state.sort);

  return params.toString();
}

export function hasActiveFilters(state: GlobalInternshipFilterState): boolean {
  return Boolean(state.search || state.location || state.datePosted);
}

export function activeFilterCount(state: GlobalInternshipFilterState): number {
  return state.datePosted ? 1 : 0;
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

/** The last instant of `date`'s day, so an inclusive `postedTo` covers it. */
function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function normalizeDateInput(value: string | null): string {
  const text = value?.trim() ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function parseDateInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;

  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(year, month - 1, day);

  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }

  return date;
}

export function resolveDateWindow(
  state: GlobalInternshipFilterState,
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

    case "last-7-days":
      return { postedFrom: addDays(today, -6).toISOString() };

    case "last-21-days":
      return { postedFrom: addDays(today, -20).toISOString() };

    /* One date means that one day — which is what someone opening a calendar
       usually wants. A second date turns it into a range. Reversed dates are
       read in the order that makes a range rather than returning nothing. */
    case "custom": {
      const picked = parseDateInput(state.customFrom);
      const until = parseDateInput(state.customTo);

      if (picked && until) {
        const [start, end] = picked.getTime() <= until.getTime() ? [picked, until] : [until, picked];
        return {
          postedFrom: start.toISOString(),
          postedTo: endOfDay(end).toISOString(),
        };
      }

      const single = picked ?? until;
      if (!single) return {};

      return { postedFrom: single.toISOString(), postedTo: endOfDay(single).toISOString() };
    }

    default:
      return {};
  }
}

export function isCustomRangeIncomplete(state: GlobalInternshipFilterState): boolean {
  return state.datePosted === "custom" && !state.customFrom && !state.customTo;
}

/**
 * The request these filters describe.
 *
 * Every control here resolves to a real query parameter the feed can answer, so
 * nothing in the filter bar looks live and filters nothing. `page` and `limit`
 * are the caller's — they belong to the list, not to the filter state.
 */
export function toFetchParams(
  state: GlobalInternshipFilterState,
  now: Date = new Date(),
): Pick<
  FetchJobsParams,
  "search" | "location" | "sort" | "postedFrom" | "postedTo"
> {
  const { postedFrom, postedTo } = resolveDateWindow(state, now);

  return {
    ...(state.search.trim() ? { search: state.search.trim() } : {}),
    ...(state.location.trim() ? { location: state.location.trim() } : {}),
    ...(postedFrom ? { postedFrom } : {}),
    ...(postedTo ? { postedTo } : {}),
    sort: state.sort,
  };
}

/**
 * The oldest day the feed will answer for, as `yyyy-mm-dd` for a date input's
 * `min`. Mirrors the API's own 21-day window so the picker cannot offer a day
 * that returns nothing.
 */
export function windowStartInput(now: Date = new Date()): string {
  return toDateInput(addDays(startOfDay(now), -(ACTIVE_WINDOW_DAYS - 1)));
}

/** Today as `yyyy-mm-dd`, for a date input's `max`. */
export function todayInput(now: Date = new Date()): string {
  return toDateInput(startOfDay(now));
}

function toDateInput(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${String(date.getFullYear())}-${month}-${day}`;
}

export function matchesFilters(
  job: PublicJob,
  state: GlobalInternshipFilterState,
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

  const { postedFrom, postedTo } = resolveDateWindow(state, now);
  if (postedFrom || postedTo) {
    const postedAt = new Date(job.postedAt).getTime();
    if (Number.isNaN(postedAt)) return false;
    if (postedFrom && postedAt < new Date(postedFrom).getTime()) return false;
    if (postedTo && postedAt > new Date(postedTo).getTime()) return false;
  }

  return true;
}
