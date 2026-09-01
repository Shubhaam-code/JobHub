"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ArrowRight, Briefcase, Database, MessageSquare, Radio, RefreshCw } from "lucide-react";

import { fetchJobs, type PublicJob } from "@/lib/api";
import { fetchAdminStats, type AdminStats } from "@/lib/admin-api";
import { formatMoment } from "@/lib/admin-format";
import { displayCompany, displayRole } from "@/lib/job-display";

/** How many days the arrivals chart covers, counting today. */
const CHART_DAYS = 7;

/** Rows in "Recent activity". */
const RECENT_COUNT = 6;

interface DayCount {
  /** "Mon", in the operator's own locale. */
  label: string;
  /** The full date, for the row's title attribute and the screen-reader text. */
  date: string;
  count: number;
}

type LoadState = "loading" | "ready" | "error";

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

/**
 * How many jobs arrived on each of the last `CHART_DAYS` days.
 *
 * One request per day, each asking for a single document and reading
 * `pagination.total` off the response — so the number is the API's own count for
 * that window rather than a bucketing of however many rows one page happened to
 * return. Windows are the operator's local days, closed at both ends.
 */
async function fetchDailyCounts(signal: AbortSignal): Promise<DayCount[]> {
  const today = startOfDay(new Date());

  const days = Array.from({ length: CHART_DAYS }, (_, index) => {
    const from = addDays(today, index - (CHART_DAYS - 1));
    const to = new Date(addDays(from, 1).getTime() - 1);
    return { from, to };
  });

  const counts = await Promise.all(
    days.map((day) =>
      fetchJobs(
        { page: 1, limit: 1, postedFrom: day.from.toISOString(), postedTo: day.to.toISOString() },
        signal,
      ).then((response) => response.pagination.total),
    ),
  );

  return days.map((day, index) => ({
    label: day.from.toLocaleDateString(undefined, { weekday: "short" }),
    date: day.from.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    count: counts[index] ?? 0,
  }));
}

function StatCard({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint: string;
  icon: typeof Briefcase;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-e1 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
          {label}
        </p>
        <span
          aria-hidden="true"
          className="grid size-8 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-strong"
        >
          <Icon className="size-4" />
        </span>
      </div>
      <p className="mt-2 font-heading text-[1.75rem] leading-none font-semibold text-foreground tabular-nums">
        {value}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-subtle-foreground">{hint}</p>
    </div>
  );
}

/**
 * The admin console's landing screen.
 *
 * The reference dashboard shows Total Jobs / Active Jobs / Applications / Total
 * Users above an "Applications Overview" chart. Two of those cannot be shown
 * honestly: the API stores no applications (a listing's apply link points at the
 * employer's own form, off-site) and has no users endpoint. So the four cards are
 * the four counts it does report, and the chart is the one time series that is
 * genuinely derivable — how many jobs arrived on each of the last seven days.
 */
export function AdminOverview() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [days, setDays] = useState<DayCount[]>([]);
  const [recent, setRecent] = useState<PublicJob[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const [nextStats, nextDays, nextRecent] = await Promise.all([
        fetchAdminStats(signal),
        fetchDailyCounts(signal),
        fetchJobs({ page: 1, limit: RECENT_COUNT, sort: "newest" }, signal),
      ]);
      if (signal.aborted) return;

      setStats(nextStats);
      setDays(nextDays);
      setRecent(nextRecent.data);
      setState("ready");
    } catch (caught: unknown) {
      if (signal.aborted) return;

      setState("error");
      setErrorMsg(caught instanceof Error ? caught.message : "An unexpected error occurred.");
    }
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // `load` only sets state after awaiting the API. The rule cannot see through
    // the await, so it reports the call itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);

    return () => controller.abort();
  }, [load, refreshKey]);

  /* Tallest bar sets the scale. Guarded at 1 so a week with no arrivals renders a
     flat baseline instead of dividing by zero. */
  const peak = Math.max(1, ...days.map((day) => day.count));

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl leading-tight font-semibold tracking-display text-foreground sm:text-3xl">
            Dashboard
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            Ingestion and feed totals, read live from the API.
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

      {state === "error" ? (
        <div className="mt-8 rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
          >
            <AlertCircle className="size-6" />
          </span>
          <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
            Unable to load the dashboard
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {errorMsg}
          </p>
          <button
            type="button"
            onClick={() => {
              setState("loading");
              setRefreshKey((key) => key + 1);
            }}
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : state === "loading" ? (
        <div className="mt-7">
          <span className="sr-only" role="status">
            Loading the dashboard
          </span>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-[7.5rem] animate-pulse rounded-lg border border-border bg-surface shadow-e1"
              />
            ))}
          </div>
          <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <div className="h-72 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
            <div className="h-72 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
          </div>
        </div>
      ) : (
        <>
          {stats && (
            <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Jobs in database"
                value={stats.jobs.inDatabase.toLocaleString()}
                hint="Every listing the public feed can serve"
                icon={Database}
              />
              <StatCard
                label="Jobs extracted"
                value={stats.jobs.extracted.toLocaleString()}
                hint={`${stats.messages.processed.toLocaleString()} messages processed`}
                icon={Briefcase}
              />
              <StatCard
                label="Messages received"
                value={stats.messages.received.toLocaleString()}
                hint={`${stats.messages.pending.toLocaleString()} pending · ${stats.messages.failed.toLocaleString()} failed`}
                icon={MessageSquare}
              />
              <StatCard
                label="Channels"
                value={stats.channels.total.toLocaleString()}
                hint={`${stats.channels.active} active · ${stats.channels.paused} paused`}
                icon={Radio}
              />
            </div>
          )}

          {stats && !stats.ingestion.telegramConfigured && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Telegram is not configured on the API, so no new messages are being received. Existing
              channels and jobs are unaffected.
            </p>
          )}

          {stats && stats.ingestion.telegramConfigured && !stats.ingestion.queueWorkerEnabled && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              The queue worker is disabled, so received messages are being stored but not yet turned
              into jobs.
            </p>
          )}

          <div className="mt-6 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
            <section className="rounded-lg border border-border bg-surface p-5 shadow-e1">
              <h2 className="font-heading text-base font-semibold tracking-snug text-foreground">
                Jobs added
              </h2>
              <p className="mt-1 text-[13px] text-subtle-foreground">
                Last {CHART_DAYS} days, counted by the date each listing was posted.
              </p>

              {/* A list, not a canvas: each row carries its own day and count as
                  text, so the figures are readable without seeing the bars and
                  without pulling in a charting library. */}
              <ol className="mt-6 flex h-48 items-end gap-2 sm:gap-3">
                {days.map((day) => (
                  <li
                    key={day.date}
                    className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2"
                  >
                    <span className="text-[13px] font-semibold text-foreground tabular-nums">
                      {day.count}
                    </span>
                    <span
                      aria-hidden="true"
                      style={{ height: `${Math.max(2, (day.count / peak) * 100)}%` }}
                      className="w-full rounded-t-sm bg-primary/85"
                    />
                    <span className="text-[11px] font-medium text-subtle-foreground">
                      {day.label}
                    </span>
                    <span className="sr-only">
                      {day.date}: {day.count} jobs
                    </span>
                  </li>
                ))}
              </ol>
            </section>

            <section className="rounded-lg border border-border bg-surface p-5 shadow-e1">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-heading text-base font-semibold tracking-snug text-foreground">
                  Recent activity
                </h2>
                <Link
                  href="/admin/jobs"
                  className="inline-flex items-center gap-1 rounded-sm text-[13px] font-semibold text-primary-strong underline-offset-2 hover:underline"
                >
                  All jobs
                  <ArrowRight className="size-3.5" aria-hidden="true" />
                </Link>
              </div>

              {recent.length === 0 ? (
                <p className="mt-6 text-sm text-subtle-foreground">
                  No jobs have been ingested yet.
                </p>
              ) : (
                <ul className="mt-4 flex flex-col divide-y divide-border">
                  {recent.map((job) => (
                    <li key={job.id} className="py-3 first:pt-0 last:pb-0">
                      <Link href={`/jobs/${job.id}`} className="group block">
                        <span className="block truncate text-sm font-medium text-foreground group-hover:text-primary-strong">
                          {displayRole(job)}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-subtle-foreground">
                          {displayCompany(job)} · {formatMoment(job.postedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
