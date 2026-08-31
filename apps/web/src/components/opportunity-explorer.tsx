"use client";

import { useCallback, useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { AlertCircle, RefreshCw, SearchX } from "lucide-react";

import {
  OPPORTUNITY_TYPE_LABELS,
  SEARCH_SUGGESTIONS,
  type OpportunityType,
} from "@/lib/opportunities";
import { fetchChannels, fetchJobs, type JobsPagination, type PublicJob } from "@/lib/api";
import { useJobSocket } from "@/lib/socket";
import { DURATION, EASE_OUT, LIST_MAX_DELAY, LIST_STAGGER } from "@/lib/motion";
import { OpportunityCard } from "./opportunity-card";
import { OpportunitySearch } from "./opportunity-search";

type TabId = "all" | OpportunityType;

const TABS: { id: TabId; label: string; apiType?: string }[] = [
  { id: "all", label: "All" },
  { id: "internship", label: OPPORTUNITY_TYPE_LABELS.internship + "s", apiType: "intern" },
  { id: "full-time", label: OPPORTUNITY_TYPE_LABELS["full-time"], apiType: "full-time" },
];

const DEFAULT_PAGE_LIMIT = 12;

/**
 * @param channel Source channel username to restrict to, or "" for all.
 */
function matchesJobFilter(job: PublicJob, query: string, tab: TabId, channel: string): boolean {
  if (tab === "internship") {
    const isIntern = Boolean(job.role && /intern/i.test(job.role));
    if (!isIntern) return false;
  } else if (tab === "full-time") {
    const isIntern = Boolean(job.role && /intern/i.test(job.role));
    if (isIntern) return false;
  }

  if (channel && job.telegramChannel?.toLowerCase() !== channel.toLowerCase()) {
    return false;
  }

  const needle = query.trim().toLowerCase();
  if (needle) {
    const searchable = [
      job.company ?? "",
      job.role ?? "",
      job.batch ?? "",
      job.telegramChannel ?? "",
      job.source ?? "",
      job.originalText ?? "",
    ]
      .join(" ")
      .toLowerCase();

    if (!searchable.includes(needle)) {
      return false;
    }
  }

  return true;
}

export function OpportunityExplorer() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tab, setTab] = useState<TabId>("all");
  const [channel, setChannel] = useState("");
  const [channels, setChannels] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [pagination, setPagination] = useState<JobsPagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reduceMotion = useReducedMotion();

  const handleNewJob = useCallback(
    (newJob: PublicJob) => {
      setJobs((prev) => {
        // Duplicate prevention
        if (prev.some((existing) => existing.id === newJob.id)) {
          return prev;
        }

        // Filter compatibility check
        if (!matchesJobFilter(newJob, debouncedQuery, tab, channel)) {
          return prev;
        }

        // Prepend newest job
        return [newJob, ...prev];
      });

      setPagination((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          total: prev.total + 1,
        };
      });
    },
    [debouncedQuery, tab, channel],
  );

  /* Realtime Socket.IO listener */
  useJobSocket(handleNewJob);

  /* Debounce search input */
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedQuery(query.trim());
    }, 350);
    return () => clearTimeout(handler);
  }, [query]);

  /* Sync active tab from URL hash */
  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash.slice(1);
      if (hash === "internships") setTab("internship");
      else if (hash === "jobs") setTab("full-time");
    };

    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  /* Load the source channel list once — the configured channels, jobs or not */
  useEffect(() => {
    let isSubscribed = true;
    const controller = new AbortController();

    fetchChannels(controller.signal)
      .then((list) => {
        if (isSubscribed) setChannels(list);
      })
      .catch(() => {
        // The source filter is optional — a failure here leaves it hidden.
      });

    return () => {
      isSubscribed = false;
      controller.abort();
    };
  }, []);

  /* Fetch jobs whenever query, tab, channel or reloadKey changes */
  useEffect(() => {
    let isSubscribed = true;
    const controller = new AbortController();

    const activeTabConfig = TABS.find((t) => t.id === tab);
    const apiType = activeTabConfig?.apiType;

    fetchJobs(
      {
        page: 1,
        limit: DEFAULT_PAGE_LIMIT,
        search: debouncedQuery || undefined,
        type: apiType,
        channel: channel || undefined,
      },
      controller.signal,
    )
      .then((response) => {
        if (!isSubscribed) return;
        setJobs(response.data);
        setPagination(response.pagination);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || !isSubscribed) return;
        setError(
          err instanceof Error
            ? "Unable to load opportunities. Please check your connection and try again."
            : "An unexpected error occurred while fetching opportunities.",
        );
        setLoading(false);
      });

    return () => {
      isSubscribed = false;
      controller.abort();
    };
  }, [debouncedQuery, tab, channel, reloadKey]);

  /* Handler to select a tab */
  const handleTabChange = (newTab: TabId) => {
    setLoading(true);
    setTab(newTab);
  };

  /* Handler to select a source channel ("" = all channels) */
  const handleChannelChange = (newChannel: string) => {
    setLoading(true);
    setChannel(newChannel);
  };

  /* Handler to update search text */
  const handleSearchChange = (newQuery: string) => {
    setLoading(true);
    setQuery(newQuery);
  };

  /* Handler to retry on error */
  const handleRetry = () => {
    setLoading(true);
    setError(null);
    setReloadKey((prev) => prev + 1);
  };

  /* Load more pagination */
  const handleLoadMore = async () => {
    if (!pagination || pagination.page >= pagination.totalPages || loadingMore) {
      return;
    }

    setLoadingMore(true);
    const nextPage = pagination.page + 1;
    const activeTabConfig = TABS.find((t) => t.id === tab);

    try {
      const response = await fetchJobs({
        page: nextPage,
        limit: DEFAULT_PAGE_LIMIT,
        search: debouncedQuery || undefined,
        type: activeTabConfig?.apiType,
        channel: channel || undefined,
      });

      setJobs((prev) => [...prev, ...response.data]);
      setPagination(response.pagination);
    } catch {
      // Keep existing jobs intact on pagination failure
    } finally {
      setLoadingMore(false);
    }
  };

  const scrollToResults = () => {
    document.getElementById("opportunities")?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start",
    });
  };

  const applySuggestion = (suggestion: string) => {
    setLoading(true);
    setTab("all");
    setQuery(suggestion);
    scrollToResults();
  };

  const resetFilters = () => {
    setLoading(true);
    setQuery("");
    setDebouncedQuery("");
    setTab("all");
    setChannel("");
  };

  const heroReveal = (order: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: DURATION.enter,
      delay: reduceMotion ? 0 : order * 0.07,
      ease: EASE_OUT,
    },
  });

  const isFiltered = debouncedQuery.length > 0 || tab !== "all" || channel.length > 0;

  return (
    <>
      <section className="border-b border-border/70 bg-gradient-to-b from-surface to-background">
        <div className="mx-auto w-full max-w-6xl px-4 pt-14 pb-14 text-center sm:px-6 sm:pt-20 sm:pb-16 lg:px-8 lg:pt-24 lg:pb-20">
          <motion.h1
            {...heroReveal(0)}
            className="mx-auto max-w-2xl text-[clamp(2rem,1.2rem+3.2vw,3.25rem)] leading-[1.06] font-semibold tracking-display text-balance"
          >
            Openings for your batch, all in one place.
          </motion.h1>

          <motion.p
            {...heroReveal(1)}
            className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg"
          >
            JobFeed gathers jobs and internships from public channels, then sorts them by role,
            batch and location — so you only see what you can actually apply to.
          </motion.p>

          <motion.div {...heroReveal(2)} className="mt-8 sm:mt-10">
            <OpportunitySearch
              value={query}
              onValueChange={handleSearchChange}
              onSubmit={scrollToResults}
            />
          </motion.div>
        </div>
      </section>

      <section
        id="opportunities"
        aria-labelledby="opportunities-title"
        className="mx-auto w-full max-w-6xl px-4 pb-16 sm:px-6 sm:pb-20 lg:px-8 lg:pb-24"
      >
        <span id="jobs" aria-hidden="true" className="block" />
        <span id="internships" aria-hidden="true" className="block" />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2
              id="opportunities-title"
              className="text-2xl font-semibold tracking-heading sm:text-[2rem]"
            >
              Latest opportunities
            </h2>
            <p className="mt-1 max-w-lg text-sm text-subtle-foreground">
              Real-time openings ingested directly from verified public channels.
            </p>
          </div>

          {pagination && pagination.total > 0 && !loading && (
            <p className="text-sm text-subtle-foreground tabular-nums">
              Showing <span className="font-semibold text-foreground">{jobs.length}</span> of{" "}
              <span className="font-semibold text-foreground">{pagination.total}</span> listings
            </p>
          )}
        </div>

        {/* One filter bar rather than a segmented control and a lone select at
            opposite ends of the row: the shell owns the border, radius and
            elevation, and the type tabs and source select sit inside it as parts
            of the same control. On mobile they stack inside the same shell. */}
        <div className="mt-6 rounded-lg border border-border bg-surface p-1.5 shadow-e1 sm:mt-7">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div
              role="group"
              aria-label="Filter by opportunity type"
              className="grid grid-cols-3 sm:inline-grid sm:grid-flow-col sm:auto-cols-max"
            >
              {TABS.map((item) => {
                const selected = tab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => handleTabChange(item.id)}
                    className={`relative inline-flex min-h-11 items-center justify-center gap-1.5 rounded-sm px-3 text-sm font-semibold transition-colors duration-150 pointer-fine:min-h-10 sm:px-5 ${
                      selected ? "text-on-primary" : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {selected && (
                      <motion.span
                        layoutId="tab-active"
                        aria-hidden="true"
                        className="absolute inset-0 rounded-sm bg-primary shadow-e1"
                        transition={{
                          duration: reduceMotion ? 0 : DURATION.state,
                          ease: EASE_OUT,
                        }}
                      />
                    )}
                    <span className="relative">{item.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Source filter — every configured channel, including ones with 0 postings. */}
            {channels.length > 1 && (
              <div className="flex items-center gap-2 border-t border-border pt-1.5 pl-1 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-3">
                <label
                  htmlFor="channel-filter"
                  className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase"
                >
                  Source
                </label>
                <select
                  id="channel-filter"
                  value={channel}
                  onChange={(event) => handleChannelChange(event.target.value)}
                  className="min-h-11 rounded-sm border border-border bg-muted px-2.5 text-sm font-medium text-foreground transition-colors duration-150 hover:border-border-strong pointer-fine:min-h-10"
                >
                  <option value="">All channels</option>
                  {channels.map((name) => (
                    <option key={name} value={name}>
                      @{name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>

        <p aria-live="polite" className="sr-only">
          {loading
            ? "Loading opportunities…"
            : `${jobs.length} ${jobs.length === 1 ? "opportunity" : "opportunities"} shown`}
        </p>

        {/* Loading State — mirrors the real card's geometry (same padding, same
            two-column action row) so the swap to content does not reflow. */}
        {loading ? (
          <div className="mt-7 grid gap-4 sm:mt-8 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div
                key={index}
                className="flex h-60 animate-pulse flex-col justify-between rounded-lg border border-border bg-surface p-5 shadow-e1"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <div className="size-10 rounded-md bg-muted" />
                      <div className="h-3.5 w-24 rounded-sm bg-muted" />
                    </div>
                    <div className="h-6 w-20 rounded-sm bg-muted" />
                  </div>
                  <div className="mt-4 h-5 w-11/12 rounded-sm bg-muted" />
                  <div className="mt-2 h-5 w-2/3 rounded-sm bg-muted" />
                  <div className="mt-3.5 h-6 w-1/3 rounded-sm bg-muted" />
                </div>
                <div className="grid grid-cols-2 gap-2 border-t border-border pt-4">
                  <div className="h-11 rounded-md bg-muted pointer-fine:h-10" />
                  <div className="h-11 rounded-md bg-muted pointer-fine:h-10" />
                </div>
              </div>
            ))}
          </div>
        ) : error ? (
          /* Error State */
          <div className="mt-7 rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center sm:mt-8 sm:py-12">
            <span
              aria-hidden="true"
              className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
            >
              <AlertCircle className="size-6" />
            </span>
            <h3 className="mt-4 font-heading text-base font-semibold text-foreground">
              Unable to load opportunities
            </h3>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              {error}
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
        ) : jobs.length > 0 ? (
          /* Success Listings */
          <>
            <ul className="mt-7 grid gap-4 sm:mt-8 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
              {jobs.map((opportunity, index) => (
                <motion.li
                  key={opportunity.id}
                  layout="position"
                  className="h-full"
                  initial={reduceMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: DURATION.enter,
                    delay: reduceMotion ? 0 : Math.min(index * LIST_STAGGER, LIST_MAX_DELAY),
                    ease: EASE_OUT,
                    layout: {
                      duration: reduceMotion ? 0 : DURATION.state,
                      ease: EASE_OUT,
                      delay: 0,
                    },
                  }}
                >
                  <OpportunityCard opportunity={opportunity} />
                </motion.li>
              ))}
            </ul>

            {/* Pagination Controls */}
            {pagination && pagination.page < pagination.totalPages && (
              <div className="mt-10 text-center">
                <button
                  type="button"
                  onClick={handleLoadMore}
                  disabled={loadingMore}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-surface px-6 text-sm font-semibold text-foreground shadow-e1 transition-[background-color,border-color,box-shadow,transform] duration-150 hover:border-border-strong hover:bg-muted hover:shadow-e2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 disabled:shadow-e1 pointer-fine:min-h-10"
                >
                  {loadingMore ? (
                    <>
                      <RefreshCw className="size-4 animate-spin" aria-hidden="true" />
                      Loading more…
                    </>
                  ) : (
                    `Load more opportunities (${jobs.length} of ${pagination.total})`
                  )}
                </button>
              </div>
            )}
          </>
        ) : (
          /* Empty State */
          <div className="mt-7 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center sm:mt-8 sm:py-14">
            <span
              aria-hidden="true"
              className="mx-auto grid size-11 place-items-center rounded-md border border-border bg-muted text-muted-foreground"
            >
              <SearchX className="size-5" />
            </span>
            <p className="mt-4 font-heading text-base font-semibold tracking-snug text-foreground">
              {isFiltered ? "No opportunities match this filter" : "No opportunities available yet"}
            </p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-subtle-foreground">
              {isFiltered
                ? "Nothing matches your search and type filter together."
                : "New job postings from public channels will appear here once ingested."}
            </p>

            {isFiltered && (
              <button
                type="button"
                onClick={resetFilters}
                className="mt-6 inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
              >
                Clear filters
              </button>
            )}

            <div className="mt-7 flex flex-wrap items-center justify-center gap-2 border-t border-border pt-6">
              <span className="text-sm text-subtle-foreground">Or try</span>
              {SEARCH_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => applySuggestion(suggestion)}
                  className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-muted-foreground transition-colors duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-9"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
