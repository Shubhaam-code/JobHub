"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Globe2, RefreshCw, SearchX, X } from "lucide-react";

import { GlobalInternshipCard } from "@/components/global-internship-card";
import { GlobalInternshipFilterBar } from "@/components/global-internship-filter-bar";
import { JobSearchForm } from "@/components/job-search-form";
import { fetchGlobalInternships, type PublicJob } from "@/lib/api";
import { useJobSocket } from "@/lib/socket";
import {
  DATE_POSTED_FILTERS,
  EMPTY_FILTERS,
  hasActiveFilters,
  isCustomRangeIncomplete,
  matchesFilters,
  parseFilters,
  serializeFilters,
  toFetchParams,
  type GlobalInternshipFilterState,
} from "@/lib/global-internship-filters";

const PAGE_LIMIT = 24;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** How far below the viewport the sentinel may sit and already load the next page. */
const INFINITE_SCROLL_ROOT_MARGIN = "400px 0px";

const DATE_LABELS = new Map(DATE_POSTED_FILTERS.map((option) => [option.id, option.label]));

/**
 * The Global Internships page.
 *
 * The URL is the state: the filter bar and the search form write to the query
 * string and the list reads back from it, so a filtered view is shareable and the
 * back button works. The list is mounted with the serialised query as its `key`,
 * which means a filter change replaces it rather than mutating it — no stale page
 * number, and no in-flight request from the previous filter to reconcile.
 */
export function GlobalInternshipsExplorer() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const query = serializeFilters(filters);

  const commit = useCallback(
    (next: GlobalInternshipFilterState) => {
      const nextQuery = serializeFilters(next);
      /* replace, not push: a filter change refines the same view, and pushing
         would make Back walk one chip at a time. */
      router.replace(nextQuery ? `/global-internships?${nextQuery}` : "/global-internships", {
        scroll: false,
      });
    },
    [router],
  );

  const clearAll = useCallback(() => commit(EMPTY_FILTERS), [commit]);

  return (
    <>
      <section className="border-b border-border bg-gradient-to-b from-primary-soft to-background">
        <div className="mx-auto w-full max-w-6xl px-4 pt-10 pb-8 sm:px-6 sm:pt-14 lg:px-8">
          <div className="flex items-center gap-2 text-sm font-semibold text-primary-strong">
            <Globe2 className="size-4" aria-hidden="true" />
            Global Internships
          </div>
          <h1 className="mt-3 font-heading text-3xl leading-tight font-semibold tracking-display text-balance text-foreground sm:text-4xl">
            Global Internships
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
            Software internship openings from the last 21 days, collected from the public GitHub
            source.
          </p>

          <div className="mt-6 max-w-3xl">
            {/* Remounted on a committed change so the boxes show the URL's values
                after a Back or a cleared filter, without an effect to sync them. */}
            <JobSearchForm
              key={query}
              defaultSearch={filters.search}
              defaultLocation={filters.location}
              onSearch={(search, location) => commit({ ...filters, search, location })}
            />
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-8 pb-16 sm:px-6 lg:px-8 lg:py-10 lg:pb-24">
        <GlobalInternshipFilterBar
          filters={filters}
          onChange={commit}
          onReset={() =>
            commit({ ...filters, datePosted: null, customFrom: "", customTo: "", sort: "newest" })
          }
        />

        {hasActiveFilters(filters) && (
          <ul className="mt-4 flex flex-wrap items-center gap-2">
            {filters.search && (
              <FilterChip
                label={`"${filters.search}"`}
                onRemove={() => commit({ ...filters, search: "" })}
              />
            )}
            {filters.location && (
              <FilterChip
                label={filters.location}
                onRemove={() => commit({ ...filters, location: "" })}
              />
            )}
            {filters.datePosted && (
              <FilterChip
                label={describeDateFilter(filters)}
                onRemove={() =>
                  commit({ ...filters, datePosted: null, customFrom: "", customTo: "" })
                }
              />
            )}
            <li>
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex min-h-9 items-center rounded-sm px-2 text-[13px] font-semibold text-primary-strong underline-offset-2 hover:underline"
              >
                Clear all
              </button>
            </li>
          </ul>
        )}

        <InternshipsList key={query} query={query} onClearFilters={clearAll} />
      </section>
    </>
  );
}

/** The chip label for the active date filter, including the picked day(s). */
function describeDateFilter(filters: GlobalInternshipFilterState): string {
  if (filters.datePosted !== "custom") {
    return DATE_LABELS.get(filters.datePosted ?? "today") ?? "Date";
  }

  const from = filters.customFrom;
  const to = filters.customTo;
  if (from && to && from !== to) return `${from} → ${to}`;
  return from || to || "Pick a date";
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onRemove}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-sm border border-primary/25 bg-primary-soft px-2.5 text-[13px] font-medium text-primary-strong transition-colors duration-150 hover:bg-primary/15"
      >
        {label}
        <X className="size-3.5" aria-hidden="true" />
        <span className="sr-only">Remove this filter</span>
      </button>
    </li>
  );
}

type Status = "loading" | "ready" | "error";

function CardSkeleton() {
  return (
    <div className="animate-pulse rounded-lg border border-border bg-surface p-5 shadow-e1">
      <div className="h-10 w-36 rounded-md bg-muted" />
      <div className="mt-5 h-5 w-11/12 rounded-sm bg-muted" />
      <div className="mt-3 h-4 w-2/3 rounded-sm bg-muted" />
      <div className="mt-12 h-11 rounded-md bg-muted" />
    </div>
  );
}

/**
 * The result grid for one exact set of filters.
 *
 * Pages are appended as the reader scrolls, so the whole 21-day window is
 * reachable rather than just the first batch.
 */
function InternshipsList({
  query,
  onClearFilters,
}: {
  query: string;
  onClearFilters: () => void;
}) {
  const filters = useMemo(() => parseFilters(new URLSearchParams(query)), [query]);

  const [internships, setInternships] = useState<PublicJob[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMessage, setErrorMessage] = useState("");
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  /* Ids already on screen, so an append and the periodic refresh can both decide
     what is new without waiting on a state update. */
  const seenIds = useRef<Set<string>>(new Set<string>());
  const loadingMoreRef = useRef(false);

  /**
   * A custom range with neither date picked is a filter the reader has not
   * finished choosing. Requesting the unfiltered feed for it would answer a
   * question they did not ask, so the list waits instead.
   */
  const awaitingDate = isCustomRangeIncomplete(filters);

  const loadFirstPage = useCallback(
    (signal?: AbortSignal) => {
      if (awaitingDate) {
        setInternships([]);
        setTotal(0);
        setTotalPages(1);
        setStatus("ready");
        return Promise.resolve();
      }

      return fetchGlobalInternships(
        { ...toFetchParams(filters), page: 1, limit: PAGE_LIMIT },
        signal,
      )
        .then((response) => {
          const unique = new Map<string, PublicJob>();
          response.data.forEach((job) => unique.set(job.id, job));
          const fresh = [...unique.values()];

          seenIds.current = new Set(fresh.map((job) => job.id));
          setInternships(fresh);
          setTotal(response.pagination.total);
          setTotalPages(Math.max(response.pagination.totalPages, 1));
          setPage(1);
          setStatus("ready");
          setErrorMessage("");
        })
        .catch((error: unknown) => {
          if (signal?.aborted) return;
          setErrorMessage(error instanceof Error ? error.message : "Could not load internships.");
          setStatus("error");
        });
    },
    [awaitingDate, filters],
  );

  useEffect(() => {
    const controller = new AbortController();
    setStatus((current) => (current === "ready" ? current : "loading"));
    void loadFirstPage(controller.signal);
    return () => controller.abort();
  }, [loadFirstPage, retryKey]);

  /* Periodic refresh of the first page only. Appended pages are left in place so
     a reader who has scrolled does not lose their position. */
  useEffect(() => {
    if (awaitingDate) return;

    const timer = window.setInterval(() => {
      void fetchGlobalInternships({ ...toFetchParams(filters), page: 1, limit: PAGE_LIMIT })
        .then((response) => {
          const additions = response.data.filter((job) => !seenIds.current.has(job.id));
          setTotal(response.pagination.total);
          setTotalPages(Math.max(response.pagination.totalPages, 1));
          if (additions.length === 0) return;
          additions.forEach((job) => seenIds.current.add(job.id));
          setInternships((current) =>
            filters.sort === "oldest" ? [...current, ...additions] : [...additions, ...current],
          );
        })
        .catch(() => {
          /* A failed background refresh leaves the list as it is. */
        });
    }, REFRESH_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [awaitingDate, filters]);

  /**
   * A new internship arriving live.
   *
   * `matchesFilters` first: the server sends every new row on this channel, and the
   * list on screen is one filtered view of them. Without the check, an internship
   * posted today would appear while "Last 21 Days → yesterday" is selected.
   *
   * `total` is deliberately not incremented — it is the server's count for these
   * filters, and guessing at it here would make the "showing N of M" line drift
   * from the pagination the next fetch reports.
   */
  const handleNewJob = useCallback(
    (job: PublicJob) => {
      if (awaitingDate || seenIds.current.has(job.id) || !matchesFilters(job, filters)) return;

      seenIds.current.add(job.id);
      setInternships((current) =>
        filters.sort === "oldest" ? [...current, job] : [job, ...current],
      );
      setTotal((current) => current + 1);
    },
    [awaitingDate, filters],
  );

  /**
   * An internship already on screen that changed — in practice, apply-link
   * discovery finishing, which is what turns its Apply button live.
   *
   * Replaced in place rather than prepended, so the card updates where it sits. A
   * row that is not on screen is ignored: it will arrive with the right position
   * on the next fetch.
   */
  const handleJobUpdated = useCallback((job: PublicJob) => {
    setInternships((current) => {
      const index = current.findIndex((existing) => existing.id === job.id);
      if (index === -1) return current;

      const next = [...current];
      next[index] = job;
      return next;
    });
  }, []);

  useJobSocket(handleNewJob, handleJobUpdated, "global-internships");

  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || page >= totalPages) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError("");

    const nextPage = page + 1;
    void fetchGlobalInternships({ ...toFetchParams(filters), page: nextPage, limit: PAGE_LIMIT })
      .then((response) => {
        const fresh = response.data.filter((job) => !seenIds.current.has(job.id));
        fresh.forEach((job) => seenIds.current.add(job.id));
        setInternships((current) => [...current, ...fresh]);
        setPage(nextPage);
        setTotal(response.pagination.total);
        setTotalPages(Math.max(response.pagination.totalPages, 1));
      })
      .catch((error: unknown) => {
        setMoreError(error instanceof Error ? error.message : "Could not load more internships.");
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [filters, page, totalPages]);

  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (sentinel === null || status !== "ready" || page >= totalPages) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: INFINITE_SCROLL_ROOT_MARGIN },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, status, page, totalPages, loadMore]);

  if (status === "loading") {
    return (
      <ul className="mt-6 grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <li key={index}>
            <CardSkeleton />
          </li>
        ))}
      </ul>
    );
  }

  if (status === "error" && internships.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-12 text-center">
        <AlertCircle className="mx-auto size-6 text-destructive" aria-hidden="true" />
        <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
          Unable to load global internships
        </h2>
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
          {errorMessage}
        </p>
        <button
          type="button"
          onClick={() => setRetryKey((key) => key + 1)}
          className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98]"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  if (awaitingDate) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
        <SearchX className="mx-auto size-6 text-primary-strong" aria-hidden="true" />
        <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
          Pick a date to filter
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Choose a day from the calendar above, or reset to see the full 21-day feed.
        </p>
      </div>
    );
  }

  if (internships.length === 0) {
    return (
      <div className="mt-6 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
        <SearchX className="mx-auto size-6 text-primary-strong" aria-hidden="true" />
        <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
          No internships match these filters
        </h2>
        <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          Nothing in the last 21 days matches. Widen the date range or clear the filters.
        </p>
        <button
          type="button"
          onClick={onClearFilters}
          className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-5 text-sm font-semibold text-foreground transition-colors duration-150 hover:bg-muted"
        >
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="mt-5 text-sm text-muted-foreground">
        <span className="font-semibold text-foreground tabular-nums">{total}</span>{" "}
        {total === 1 ? "internship" : "internships"} found
        {internships.length < total && (
          <span className="text-subtle-foreground"> · showing {internships.length}</span>
        )}
      </p>

      <ul className="mt-4 grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
        {internships.map((internship) => (
          <li key={internship.id}>
            <GlobalInternshipCard opportunity={internship} />
          </li>
        ))}
      </ul>

      {loadingMore && (
        <ul className="mt-4 grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <li key={index}>
              <CardSkeleton />
            </li>
          ))}
        </ul>
      )}

      {moreError && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 rounded-md border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-muted-foreground">
          {moreError}
          <button
            type="button"
            onClick={loadMore}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-semibold text-foreground hover:bg-muted"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Retry
          </button>
        </div>
      )}

      {/* Observed to append the next page. Absent on the last page, which is what
          ends the scroll rather than a guard inside the callback. */}
      {page < totalPages && !moreError && <div ref={setSentinel} className="h-px w-full" />}
    </>
  );
}
