import { Suspense } from "react";

import { JobsExplorer } from "@/components/jobs-explorer";

export const metadata = {
  title: "Explore Jobs",
  description: "Browse every opening in the feed and filter it by date posted and job type.",
};

/**
 * The Jobs listing route.
 *
 * `JobsExplorer` reads the filters out of `useSearchParams`, which suspends on
 * the server, so the boundary lives here rather than inside the component — the
 * page shell renders immediately and only the list waits.
 */
export default function JobsPage() {
  return (
    <Suspense fallback={<JobsFallback />}>
      <JobsExplorer />
    </Suspense>
  );
}

function JobsFallback() {
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
          <div className="mt-6 h-[4.75rem] max-w-3xl rounded-xl border border-border bg-surface shadow-e3" />
        </div>
      </section>

      <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 pt-8 pb-16 sm:px-6 lg:grid-cols-[17rem_1fr] lg:gap-8 lg:px-8 lg:pb-24">
        <div className="hidden h-96 animate-pulse rounded-lg border border-border bg-surface shadow-e1 lg:block" />
        <ul className="flex min-w-0 flex-col gap-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <li
              key={index}
              className="flex animate-pulse items-start gap-4 rounded-lg border border-border bg-surface p-5 shadow-e1"
            >
              <div className="size-12 shrink-0 rounded-md bg-muted" />
              <div className="flex-1">
                <div className="h-5 w-2/3 rounded-sm bg-muted" />
                <div className="mt-2 h-4 w-1/3 rounded-sm bg-muted" />
                <div className="mt-4 h-6 w-1/2 rounded-sm bg-muted" />
              </div>
              <div className="hidden h-11 w-28 rounded-md bg-muted sm:block" />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
