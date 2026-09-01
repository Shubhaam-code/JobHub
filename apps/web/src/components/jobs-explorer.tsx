"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, RefreshCw, SearchX, SlidersHorizontal, X } from "lucide-react";

import { JobFiltersPanel } from "@/components/job-filters-panel";
import { JobListRow } from "@/components/job-list-row";
import { JobSearchForm } from "@/components/job-search-form";
import { fetchJobs, type PublicJob } from "@/lib/api";
import {
  DATE_POSTED_FILTERS,
  EMPTY_FILTERS,
  JOB_TYPE_FILTERS,
  hasActiveFilters,
  isCustomRangeIncomplete,
  matchesFilters,
  parseFilters,
  serializeFilters,
  toFetchParams,
  type JobFilterState,
} from "@/lib/job-filters";
import { useJobSocket } from "@/lib/socket";

const PAGE_LIMIT = 12;

/**
 * How far below the viewport the sentinel may still be and already trigger the
 * next batch — roughly a screenful of runway, so the next page is usually in
 * place by the time the reader reaches the end of the list.
 */
const INFINITE_SCROLL_ROOT_MARGIN = "400px 0px";

/** Placeholder rows shown while a batch is in flight — enough to read as "more
    is coming", not so many that they dominate the list. */
const BATCH_SKELETONS = 3;

const DATE_LABELS = new Map(DATE_POSTED_FILTERS.map((option) => [option.id, option.label]));
const TYPE_LABELS = new Map(JOB_TYPE_FILTERS.map((option) => [option.id, option.label]));

/**
 * The Jobs page.
 *
 * The URL is the state: every control writes to the query string and the list
 * reads back from it, so a filtered view is shareable, the back button works, and
 * there is only one place the current filter lives.
 */
export function JobsExplorer() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);

  /* The canonical query for these filters — not `searchParams.toString()`, which
     may carry unknown params or a different ordering. It is both what the URL is
     set to and the key that remounts the list and the panel. */
  const query = serializeFilters(filters);

  const commit = useCallback(
    (next: JobFilterState) => {
      const nextQuery = serializeFilters(next);
      /* replace, not push: a filter change is a refinement of the same view, and
         pushing would make Back walk one radio at a time. `scroll: false` keeps
         the reader where they were in the list. */
      router.replace(nextQuery ? `/jobs?${nextQuery}` : "/jobs", { scroll: false });
    },
    [router],
  );

  const clearAll = useCallback(() => commit(EMPTY_FILTERS), [commit]);

  return (
    <>
      <section className="border-b border-border bg-gradient-to-b from-primary-soft to-background">
        <div className="mx-auto w-full max-w-6xl px-4 pt-10 pb-8 sm:px-6 sm:pt-14 lg:px-8">
          <h1 className="font-heading text-3xl leading-tight font-semibold tracking-display text-balance text-foreground sm:text-4xl">
            Explore Jobs
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
            Every opening currently in the feed. Narrow it by when it was posted and what kind of
            work it is.
          </p>

          <div className="mt-6 max-w-3xl">
            {/* Remounted on a committed change so the boxes show the URL's values
                after a Back or a cleared filter, without syncing from an effect. */}
            <JobSearchForm
              key={query}
              defaultSearch={filters.search}
              defaultLocation={filters.location}
              onSearch={(search, location) => commit({ ...filters, search, location })}
            />
          </div>
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 pt-8 pb-16 sm:px-6 lg:grid-cols-[17rem_1fr] lg:gap-8 lg:px-8 lg:pb-24">
        {/* One panel, shown inline from lg and behind a toggle below it. Rendering
            it once keeps a single source of truth for the form state. */}
        <div className="lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7.5rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain">
          <button
            type="button"
            onClick={() => setFiltersOpen((open) => !open)}
            aria-expanded={filtersOpen}
            aria-controls="job-filters"
            className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-semibold text-foreground shadow-e1 transition-colors duration-150 hover:bg-muted lg:hidden"
          >
            <SlidersHorizontal className="size-4 text-primary-strong" aria-hidden="true" />
            {filtersOpen ? "Hide filters" : "Show filters"}
          </button>

          <div id="job-filters" className={`${filtersOpen ? "mt-3 block" : "hidden"} lg:block`}>
            <JobFiltersPanel
              key={query}
              initial={filters}
              onApply={(next) => {
                commit(next);
                setFiltersOpen(false);
              }}
              onReset={() =>
                commit({
                  ...filters,
                  datePosted: null,
                  jobType: null,
                  customFrom: "",
                  customTo: "",
                })
              }
            />
          </div>
        </div>

        <div className="min-w-0">
          {/* Chips repeat what the sidebar holds, at the top of the results where
              a reader looks to understand why the list is short. Each one removes
              just its own filter. */}
          {hasActiveFilters(filters) && (
            <ul className="mb-4 flex flex-wrap items-center gap-2">
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
                  label={DATE_LABELS.get(filters.datePosted) ?? filters.datePosted}
                  onRemove={() =>
                    commit({ ...filters, datePosted: null, customFrom: "", customTo: "" })
                  }
                />
              )}
              {filters.jobType && (
                <FilterChip
                  label={TYPE_LABELS.get(filters.jobType) ?? filters.jobType}
                  onRemove={() => commit({ ...filters, jobType: null })}
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

          <JobsList
            key={query}
            query={query}
            sort={filters.sort}
            onSortChange={(sort) => commit({ ...filters, sort })}
            onClearFilters={clearAll}
          />
        </div>
      </div>
    </>
  );
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

type Status = "loading" | "error" | "ready";

/**
 * One row-shaped placeholder.
 *
 * Same box model as `JobListRow` — monogram, two text lines, meta row, action
 * column — so a batch landing replaces a skeleton with a card of about the same
 * height and nothing already read on screen moves.
 */
function JobRowSkeleton() {
  return (
    <div className="flex animate-pulse items-start gap-4 rounded-lg border border-border bg-surface p-4 shadow-e1 sm:gap-5 sm:p-5">
      <div className="size-12 shrink-0 rounded-md bg-muted" />
      <div className="min-w-0 flex-1">
        <div className="h-5 w-2/3 rounded-sm bg-muted" />
        <div className="mt-2 h-4 w-1/3 rounded-sm bg-muted" />
        <div className="mt-3 h-6 w-1/2 rounded-sm bg-muted" />
      </div>
      <div className="hidden h-11 w-28 rounded-md bg-muted sm:block" />
    </div>
  );
}

/**
 * The result list for one exact set of filters.
 *
 * Mounted with a `key` of the serialised query, so a filter change replaces this
 * component rather than mutating it: the first fetch runs once on mount and there
 * is no state to reset, no stale page number and no in-flight request from the
 * previous filter to reconcile.
 */
function JobsList({
  query,
  sort,
  onSortChange,
  onClearFilters,
}: {
  query: string;
  sort: JobFilterState["sort"];
  onSortChange: (sort: JobFilterState["sort"]) => void;
  onClearFilters: () => void;
}) {
  const filters = useMemo(() => parseFilters(new URLSearchParams(query)), [query]);

  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [liveAdded, setLiveAdded] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  /* Ids already on screen. Kept in a ref rather than derived from `jobs` so both
     the socket handler and the next batch can decide *before* updating state
     whether a job is new — which is what keeps the count honest. */
  const seenIds = useRef<Set<string>>(new Set());

  /** The element observed below the list; state, not a ref, so the observer
      effect re-runs when it mounts or unmounts. */
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  /** Mirrors `loadingMore` for the observer callback, which has to decide
      synchronously whether a batch is already in flight. */
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    fetchJobs(toFetchParams(filters, 1, PAGE_LIMIT), controller.signal)
      .then((response) => {
        if (!live) return;
        seenIds.current = new Set(response.data.map((job) => job.id));
        setJobs(response.data);
        setTotal(response.pagination.total);
        setTotalPages(response.pagination.totalPages);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !live) return;
        setErrorMsg(error instanceof Error ? error.message : "An unexpected error occurred.");
        setStatus("error");
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [filters, retryKey]);

  const handleRetry = () => {
    setStatus("loading");
    setErrorMsg("");
    setRetryKey((key) => key + 1);
  };

  const hasMore = page < totalPages;

  /* Fetch the next page and append it.
     Safe to call repeatedly: it returns early while a batch is in flight and
     once the last page has been loaded, so the observer below can fire freely. */
  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || page >= totalPages) return;

    const next = page + 1;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setMoreError("");

    fetchJobs(toFetchParams(filters, next, PAGE_LIMIT))
      .then((response) => {
        /* A live arrival prepends and shifts the page window, so a job already
           listed can come back on a later page. Append only ids not yet seen. */
        const fresh = response.data.filter((job) => !seenIds.current.has(job.id));
        fresh.forEach((job) => seenIds.current.add(job.id));

        setJobs((current) => [...current, ...fresh]);
        setPage(next);
        setTotal(response.pagination.total);
        setTotalPages(response.pagination.totalPages);
      })
      .catch((error: unknown) => {
        // Keep the loaded jobs. Auto-loading pauses on failure rather than
        // re-firing against a failing endpoint every time the sentinel is seen.
        setMoreError(error instanceof Error ? error.message : "Could not load more jobs.");
      })
      .finally(() => {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      });
  }, [filters, page, totalPages]);

  /* Infinite scroll: load the next batch when the sentinel below the list comes
     into view. The observer is rebuilt whenever the fetch state changes, and a
     fresh observer reports the sentinel's current intersection immediately —
     which is what continues the sequence when a batch lands and the sentinel is
     still on screen (tall viewport, or a batch shorter than a screenful). */
  useEffect(() => {
    if (!sentinel || !hasMore || loadingMore || moreError) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: INFINITE_SCROLL_ROOT_MARGIN },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, hasMore, loadingMore, moreError, loadMore]);

  /* A job ingested while this list is open joins it, but only if it genuinely
     belongs: it has to pass the same filters the query applied, and the list has
     to be newest-first — prepending to an oldest-first list would put it in the
     wrong place. */
  const handleNewJob = useCallback(
    (job: PublicJob) => {
      if (filters.sort !== "newest") return;
      if (seenIds.current.has(job.id)) return;
      if (!matchesFilters(job, filters)) return;

      seenIds.current.add(job.id);
      setJobs((current) => [job, ...current]);
      setLiveAdded((count) => count + 1);
    },
    [filters],
  );

  useJobSocket(handleNewJob);

  const shownTotal = total + liveAdded;
  const incompleteRange = isCustomRangeIncomplete(filters);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <p className="text-sm text-muted-foreground" role="status">
          {status === "loading" ? (
            "Loading jobs…"
          ) : status === "error" ? (
            "Could not load jobs"
          ) : (
            <>
              <span className="font-semibold text-foreground tabular-nums">{shownTotal}</span>{" "}
              {shownTotal === 1 ? "job" : "jobs"} found
            </>
          )}
        </p>

        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground">
          Sort by
          <select
            value={sort}
            onChange={(event) => onSortChange(event.target.value === "oldest" ? "oldest" : "newest")}
            className="min-h-10 rounded-md border border-border bg-surface px-2 text-sm font-medium text-foreground"
          >
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
          </select>
        </label>
      </div>

      {/* "Custom Date" with neither end filled in is not a query yet, so the list
          below is the unfiltered feed. Saying so beats letting it look filtered. */}
      {incompleteRange && (
        <p className="mt-4 rounded-md border border-border bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
          Pick a From or To date to narrow this list.
        </p>
      )}

      {status === "loading" ? (
        <ul className="mt-5 flex flex-col gap-4">
          {Array.from({ length: 5 }).map((_, index) => (
            <li key={index}>
              <JobRowSkeleton />
            </li>
          ))}
        </ul>
      ) : status === "error" ? (
        <div className="mt-5 rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-12 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
          >
            <AlertCircle className="size-6" />
          </span>
          <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
            Unable to load jobs
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {errorMsg}
          </p>
          <button
            type="button"
            onClick={handleRetry}
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : jobs.length === 0 ? (
        /* Nothing matched. Deliberately no "you might also like" fallback: the
           reader asked a specific question and this is its answer. */
        <div className="mt-5 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-11 place-items-center rounded-md bg-primary-soft text-primary-strong"
          >
            <SearchX className="size-5" />
          </span>
          <p className="mt-4 font-heading text-base font-semibold tracking-snug text-foreground">
            No jobs match these filters
          </p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-subtle-foreground">
            Try a wider date range, a different job type, or clear the filters to see everything in
            the feed.
          </p>
          {hasActiveFilters(filters) && (
            <button
              type="button"
              onClick={onClearFilters}
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
            >
              Clear all filters
            </button>
          )}
        </div>
      ) : (
        <>
          <ul className="mt-5 flex flex-col gap-4">
            {jobs.map((job) => (
              <li key={job.id}>
                <JobListRow job={job} />
              </li>
            ))}

            {/* The batch grows the list from the bottom, inside the same list and
                on the same gap, so the rows above it hold their position while it
                loads. Decorative: the status line below is what is announced. */}
            {loadingMore &&
              Array.from({ length: BATCH_SKELETONS }).map((_, index) => (
                <li key={`pending-${index}`} aria-hidden="true">
                  <JobRowSkeleton />
                </li>
              ))}
          </ul>

          {loadingMore && (
            <span className="sr-only" role="status">
              Loading more jobs
            </span>
          )}

          {/* Infinite scroll sentinel — sits directly below the list so it is
              seen as the reader nears the end of what is loaded. Unmounted on
              the last page, which is what silently stops further requests. */}
          {hasMore && <div ref={setSentinel} aria-hidden="true" className="h-px w-full" />}

          {/* A failed batch pauses auto-loading, so this is the way back. */}
          {moreError && !loadingMore && (
            <div className="mt-6 flex flex-col items-center gap-3 text-center">
              <p className="text-[13px] text-muted-foreground">{moreError}</p>
              <button
                type="button"
                onClick={loadMore}
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-5 text-sm font-semibold text-foreground shadow-e1 transition-[background-color,border-color] duration-150 hover:border-border-strong hover:bg-muted pointer-fine:min-h-10"
              >
                <RefreshCw className="size-4" aria-hidden="true" />
                Try again
              </button>
            </div>
          )}

          {!hasMore && !loadingMore && (
            <p className="mt-8 text-center text-[13px] text-subtle-foreground">
              You have reached the end of the list.
            </p>
          )}
        </>
      )}
    </>
  );
}
