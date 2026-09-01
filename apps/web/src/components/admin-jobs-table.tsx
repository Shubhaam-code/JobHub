"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ExternalLink, RefreshCw, Search } from "lucide-react";

import { fetchJobs, type PublicJob } from "@/lib/api";
import {
  displayCompany,
  displayEmploymentType,
  displayLocation,
  displayRole,
  formatPostedDate,
  inferOpportunityType,
} from "@/lib/job-display";
import { resolveLink } from "@/lib/links";
import { OPPORTUNITY_TYPE_LABELS } from "@/lib/opportunities";

const PAGE_SIZE = 20;

type LoadState = "loading" | "ready" | "error";

/**
 * Every listing in the feed, as a table.
 *
 * Read-only, and that is a statement about the system rather than an omission: the
 * API has no create, edit or delete route for a job — listings are extracted from
 * ingested channel messages, so the way to stop one appearing is to pause its
 * channel. The reference design's "+ Add New Job" button and per-row edit and
 * delete icons would therefore have had nothing to call, so this screen offers the
 * two actions that do work: open the listing, and open the employer's apply link.
 */
export function AdminJobsTable() {
  const [search, setSearch] = useState("");
  /** The term the current results are for — only updated on submit. */
  const [applied, setApplied] = useState("");
  const [page, setPage] = useState(1);

  const [jobs, setJobs] = useState<PublicJob[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;

    setState("loading");

    fetchJobs(
      { page, limit: PAGE_SIZE, sort: "newest", ...(applied ? { search: applied } : {}) },
      controller.signal,
    )
      .then((response) => {
        if (!live) return;
        setJobs(response.data);
        setTotal(response.pagination.total);
        setTotalPages(response.pagination.totalPages);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !live) return;
        setErrorMsg(error instanceof Error ? error.message : "An unexpected error occurred.");
        setState("error");
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [applied, page, refreshKey]);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // A new term is a new result set, so it starts at page one.
    setPage(1);
    setApplied(search.trim());
  };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl leading-tight font-semibold tracking-display text-foreground sm:text-3xl">
            Jobs
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground" role="status">
            {state === "loading" ? (
              "Loading listings…"
            ) : state === "error" ? (
              "Could not load listings"
            ) : (
              <>
                <span className="font-semibold text-foreground tabular-nums">
                  {total.toLocaleString()}
                </span>{" "}
                {total === 1 ? "listing" : "listings"}
                {applied && <> matching “{applied}”</>}
              </>
            )}
          </p>
        </div>

        <button
          type="button"
          onClick={() => setRefreshKey((key) => key + 1)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      <form onSubmit={handleSubmit} role="search" className="mt-6 flex flex-wrap gap-2">
        <div className="relative min-w-56 flex-1">
          <label htmlFor="admin-jobs-search" className="sr-only">
            Search by company or role
          </label>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle-foreground"
          />
          <input
            id="admin-jobs-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by company or role"
            className="min-h-11 w-full rounded-md border border-border bg-surface pr-3 pl-10 text-sm text-foreground placeholder:text-subtle-foreground focus:border-primary focus:outline-none pointer-fine:min-h-10"
          />
        </div>
        <button
          type="submit"
          className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
        >
          Search
        </button>
        {applied && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setApplied("");
              setPage(1);
            }}
            className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
          >
            Clear
          </button>
        )}
      </form>

      {state === "error" ? (
        <div className="mt-6 rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
          >
            <AlertCircle className="size-6" />
          </span>
          <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
            Unable to load listings
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {errorMsg}
          </p>
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : state === "loading" ? (
        <div className="mt-6">
          <span className="sr-only" role="status">
            Loading listings
          </span>
          <div className="h-96 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
        </div>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface shadow-e1">
            <table className="w-full min-w-[52rem] border-collapse text-sm">
              <caption className="sr-only">
                Every job listing in the feed, newest first, with links to the listing and to the
                employer&apos;s apply page
              </caption>
              <thead>
                <tr className="border-b border-border text-left">
                  {["Job Title", "Company", "Job Type", "Posted On", "Actions"].map((heading) => (
                    <th
                      key={heading}
                      scope="col"
                      className={`px-4 py-3 text-[11px] font-semibold tracking-label text-subtle-foreground uppercase ${
                        heading === "Actions" ? "text-right" : ""
                      }`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-sm text-subtle-foreground">
                      {applied
                        ? `No listing matches “${applied}”.`
                        : "No jobs have been ingested yet."}
                    </td>
                  </tr>
                ) : (
                  jobs.map((job) => {
                    const stored = displayEmploymentType(job);
                    const location = displayLocation(job);
                    const applyLink = resolveLink(job.applyUrl);

                    return (
                      <tr key={job.id} className="border-b border-border/70 last:border-b-0">
                        <td className="px-4 py-3">
                          <Link
                            href={`/jobs/${job.id}`}
                            className="font-medium text-foreground hover:text-primary-strong"
                          >
                            {displayRole(job)}
                          </Link>
                          {location && (
                            <span className="mt-0.5 block text-xs text-subtle-foreground">
                              {location}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{displayCompany(job)}</td>
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center rounded-sm border border-border bg-muted px-2 py-1 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
                            {OPPORTUNITY_TYPE_LABELS[inferOpportunityType(job.role)]}
                          </span>
                          {/* The stored value when the source text carried one —
                              shown alongside rather than instead of the derived
                              type, which is what the public filters use. */}
                          {stored && (
                            <span className="mt-0.5 block text-xs text-subtle-foreground">
                              {stored}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatPostedDate(job.postedAt)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <Link
                              href={`/jobs/${job.id}`}
                              className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-3 text-[13px] font-semibold text-foreground transition-[background-color,border-color] duration-150 hover:border-border-strong hover:bg-muted"
                            >
                              View
                            </Link>
                            {applyLink && (
                              <a
                                href={applyLink.href}
                                {...(applyLink.kind === "email"
                                  ? {}
                                  : { target: "_blank", rel: "noopener noreferrer" })}
                                className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-[13px] font-semibold text-primary-strong underline-offset-2 hover:underline"
                              >
                                Apply link
                                <ExternalLink className="size-3.5" aria-hidden="true" />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-subtle-foreground tabular-nums">
              Page {page} of {totalPages}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={page <= 1}
                className="inline-flex min-h-10 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                Previous
              </button>
              <button
                type="button"
                onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
                disabled={page >= totalPages}
                className="inline-flex min-h-10 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                Next
              </button>
            </div>
          </div>

          <p className="mt-4 max-w-3xl text-xs leading-relaxed text-subtle-foreground">
            Listings are extracted from ingested channel messages, so there is no manual add, edit or
            delete — to stop a source producing new listings, pause its channel on the{" "}
            <Link href="/admin/channels" className="font-medium underline underline-offset-2">
              Channels
            </Link>{" "}
            screen.
          </p>
        </>
      )}
    </>
  );
}
