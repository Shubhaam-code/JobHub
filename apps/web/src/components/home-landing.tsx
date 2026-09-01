"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Building2, RefreshCw } from "lucide-react";

import { JobSearchForm } from "@/components/job-search-form";
import { OpportunityCard } from "@/components/opportunity-card";
import { fetchJobs, type PublicJob } from "@/lib/api";
import { popularSearchTerms, topCompanies } from "@/lib/job-highlights";
import { useJobSocket } from "@/lib/socket";

/**
 * How many postings the homepage reads.
 *
 * One request serves all three sections: the newest few as cards, and the whole
 * sample as the population the company row and the popular searches are counted
 * over. A wider sample makes those two rows more representative, so this sits at
 * the API's own per-page ceiling rather than at the card count.
 */
const SAMPLE_SIZE = 100;

/** Cards under the hero. Two full rows of three at desktop widths. */
const LATEST_COUNT = 6;

const COMPANY_COUNT = 8;
const TERM_COUNT = 6;

type Status = "loading" | "ready" | "error";

/**
 * The landing page.
 *
 * Everything on it is read from the live feed. The reference design shows a fixed
 * row of well-known company logos and a fixed list of popular searches; both are
 * replaced here by counts over the jobs actually in the database, because a logo
 * wall of companies that have not posted anything would be decoration claiming to
 * be information — and every chip here is a query that returns results.
 */
export function HomeLanding() {
  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    fetchJobs({ page: 1, limit: SAMPLE_SIZE, sort: "newest" }, controller.signal)
      .then((response) => {
        if (!live) return;
        setJobs(response.data);
        setTotal(response.pagination.total);
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
  }, [retryKey]);

  /* A job ingested while the page is open joins the sample at the front — the
     list is newest-first, so that is where it belongs. The counts and the cards
     both re-derive from it. */
  const handleNewJob = useCallback((job: PublicJob) => {
    setJobs((current) => {
      if (current.some((existing) => existing.id === job.id)) return current;
      return [job, ...current].slice(0, SAMPLE_SIZE);
    });
    setTotal((current) => current + 1);
  }, []);

  useJobSocket(handleNewJob);

  const companies = useMemo(() => topCompanies(jobs, COMPANY_COUNT), [jobs]);
  const terms = useMemo(() => popularSearchTerms(jobs, TERM_COUNT), [jobs]);
  const latest = jobs.slice(0, LATEST_COUNT);

  const handleRetry = () => {
    setStatus("loading");
    setErrorMsg("");
    setRetryKey((key) => key + 1);
  };

  return (
    <>
      <section className="border-b border-border bg-gradient-to-b from-primary-soft to-background">
        <div className="mx-auto w-full max-w-4xl px-4 pt-10 pb-8 text-center sm:px-6 sm:pt-12 lg:px-8 lg:pt-14 lg:pb-10">
          <h1 className="font-heading text-4xl leading-[1.1] font-semibold tracking-display text-balance text-foreground sm:text-5xl lg:text-[2.75rem]">
            Find your dream job
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg lg:text-base">
            Every opening collected here in one feed. Search by role, company or location — and apply
            straight at the source.
          </p>

          <div className="mt-6 text-left lg:mt-5">
            {/* No `onSearch`: submitting takes the reader to /jobs with the words
                in the URL, where the filters live. */}
            <JobSearchForm variant="hero" />
          </div>

          {/* Only rendered once real role words have been counted, so this line
              never appears as an empty label or a guess. */}
          {terms.length > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-2 text-sm lg:mt-3.5">
              <span className="text-subtle-foreground">Popular searches:</span>
              {terms.map((term) => (
                <Link
                  key={term}
                  href={`/jobs?q=${encodeURIComponent(term)}`}
                  className="inline-flex min-h-8 items-center rounded-full border border-border bg-surface px-3 text-[13px] font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-primary/40 hover:bg-primary-soft hover:text-primary-strong"
                >
                  {term}
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>

      {status === "error" ? (
        <section className="mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-12 text-center">
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
        </section>
      ) : (
        <>
          <section className="border-b border-border/70 bg-surface">
            <div className="mx-auto w-full max-w-6xl px-4 py-7 sm:px-6 lg:px-8 lg:py-8">
              <h2 className="text-center text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                Companies hiring now
              </h2>

              {status === "loading" ? (
                <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, index) => (
                    <li
                      key={index}
                      className="h-16 animate-pulse rounded-lg border border-border bg-muted"
                    />
                  ))}
                </ul>
              ) : companies.length === 0 ? (
                <p className="mt-4 text-center text-sm text-muted-foreground">
                  No companies in the feed yet.
                </p>
              ) : (
                <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                  {companies.map((company) => (
                    <li key={company.name}>
                      <Link
                        href={`/jobs?q=${encodeURIComponent(company.name)}`}
                        className="flex min-h-16 items-center gap-3 rounded-lg border border-border bg-background px-3.5 py-3 transition-[border-color,box-shadow] duration-150 hover:border-primary/40 hover:shadow-e1"
                      >
                        {/* A monogram, not a logo: nothing in the feed carries a
                            company mark, and fetching one from a guessed domain
                            would attribute a brand we cannot verify. */}
                        <span
                          aria-hidden="true"
                          className="grid size-10 shrink-0 place-items-center rounded-md bg-primary-soft font-heading text-sm leading-none font-semibold text-primary-strong"
                        >
                          {company.name.charAt(0).toUpperCase()}
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-foreground">
                            {company.name}
                          </span>
                          <span className="block text-xs text-subtle-foreground tabular-nums">
                            {company.count} {company.count === 1 ? "opening" : "openings"}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <section className="mx-auto w-full max-w-6xl px-4 pt-8 pb-12 sm:px-6 lg:px-8 lg:pt-10 lg:pb-16">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-heading text-2xl leading-tight font-semibold tracking-display text-foreground sm:text-3xl lg:text-2xl">
                  Latest jobs
                </h2>
                <p className="mt-1.5 text-[15px] text-muted-foreground lg:text-sm" role="status">
                  {status === "loading" ? (
                    "Loading the newest openings…"
                  ) : (
                    <>
                      The newest of{" "}
                      <span className="font-semibold text-foreground tabular-nums">{total}</span>{" "}
                      {total === 1 ? "opening" : "openings"} in the feed.
                    </>
                  )}
                </p>
              </div>

              <Link
                href="/jobs"
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-semibold text-foreground shadow-e1 transition-[background-color,border-color] duration-150 hover:border-border-strong hover:bg-muted pointer-fine:min-h-10"
              >
                View all jobs
                <ArrowRight className="size-4" aria-hidden="true" />
              </Link>
            </div>

            {status === "loading" ? (
              <ul className="mt-5 grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
                {Array.from({ length: LATEST_COUNT }).map((_, index) => (
                  <li
                    key={index}
                    className="h-60 animate-pulse rounded-lg border border-border bg-surface shadow-e1"
                  />
                ))}
              </ul>
            ) : latest.length === 0 ? (
              <div className="mt-5 rounded-lg border border-dashed border-border-strong bg-surface px-6 py-14 text-center">
                <span
                  aria-hidden="true"
                  className="mx-auto grid size-11 place-items-center rounded-md bg-primary-soft text-primary-strong"
                >
                  <Building2 className="size-5" />
                </span>
                <p className="mt-4 font-heading text-base font-semibold tracking-snug text-foreground">
                  No jobs in the feed yet
                </p>
                <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-subtle-foreground">
                  New postings appear here as soon as they are collected.
                </p>
              </div>
            ) : (
              <ul className="mt-5 grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
                {latest.map((job) => (
                  <li key={job.id} className="h-full">
                    <OpportunityCard opportunity={job} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
