import { Suspense } from "react";

import { GlobalInternshipsExplorer } from "@/components/global-internships-explorer";

export const metadata = {
  title: "Global Internships",
  description: "Browse current global software internships sourced from GitHub.",
};

/**
 * The Global Internships route.
 *
 * `GlobalInternshipsExplorer` reads its filters out of `useSearchParams`, which
 * suspends on the server, so the boundary lives here — the page shell renders
 * immediately and only the list waits.
 */
export default function GlobalInternshipsPage() {
  return (
    <Suspense fallback={<GlobalInternshipsFallback />}>
      <GlobalInternshipsExplorer />
    </Suspense>
  );
}

function GlobalInternshipsFallback() {
  return (
    <>
      <section className="border-b border-border bg-gradient-to-b from-primary-soft to-background">
        <div className="mx-auto w-full max-w-6xl px-4 pt-10 pb-8 sm:px-6 sm:pt-14 lg:px-8">
          <h1 className="font-heading text-3xl leading-tight font-semibold tracking-display text-balance text-foreground sm:text-4xl">
            Global Internships
          </h1>
          <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted-foreground">
            Software internship openings from the last 21 days, collected from the public GitHub
            source.
          </p>
          <div className="mt-6 h-[4.75rem] max-w-3xl rounded-xl border border-border bg-surface shadow-e3" />
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 py-8 pb-16 sm:px-6 lg:px-8 lg:py-10 lg:pb-24">
        <div className="h-24 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
        <ul className="mt-6 grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <li
              key={index}
              className="animate-pulse rounded-lg border border-border bg-surface p-5 shadow-e1"
            >
              <div className="h-10 w-36 rounded-md bg-muted" />
              <div className="mt-5 h-5 w-11/12 rounded-sm bg-muted" />
              <div className="mt-3 h-4 w-2/3 rounded-sm bg-muted" />
              <div className="mt-12 h-11 rounded-md bg-muted" />
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
