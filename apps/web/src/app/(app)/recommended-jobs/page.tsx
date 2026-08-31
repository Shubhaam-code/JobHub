"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Check,
  FileUp,
  RefreshCw,
  SearchX,
  Sparkles,
  SlidersHorizontal,
} from "lucide-react";

import { RecommendationCard } from "@/components/recommendation-card";
import { fetchRecommendations, type Recommendation } from "@/lib/profile";

/**
 * The five dimensions `scoreJob` actually scores, in the order the API weights
 * them. Named here only so the empty state can show what gets compared — the
 * real reasons on a real card always come from the matcher, never from the UI.
 */
const SCORED_DIMENSIONS = ["Skills", "Role", "Location"] as const;

/**
 * A silent, inert specimen of a match card.
 *
 * Stands in for the usual grey icon-in-a-box: it shows the anatomy the user is
 * about to get — monogram, role, score, reasons — with the job's own fields left
 * as blank bars, because no job has been matched yet and inventing one here
 * would be the one thing this whole screen exists to avoid. The reason rows name
 * the dimensions the engine compares, which is true of every card it produces.
 *
 * Decorative in the accessibility tree: the panel's prose already says all of
 * this, so a screen reader should not have to read a mock card to hear it.
 */
function MatchPreview() {
  return (
    <div
      aria-hidden="true"
      className="rounded-md border border-border bg-background p-4 sm:p-5 lg:p-6"
    >
      <div className="rounded-lg border border-border bg-surface p-4 shadow-e2">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="size-9 shrink-0 rounded-md border border-border bg-muted" />
            <span className="h-3 w-20 rounded-sm bg-muted" />
          </div>
          <span className="inline-flex shrink-0 items-center rounded-sm border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] font-semibold tracking-label text-accent-strong uppercase tabular-nums">
            92% Match
          </span>
        </div>

        {/* The role line, left blank: the score and the reasons are what this
            preview is teaching, and a placeholder job title would read as one. */}
        <div className="mt-4 h-4 w-11/12 rounded-sm bg-muted" />
        <div className="mt-2 h-4 w-2/3 rounded-sm bg-muted" />

        <ul className="mt-4 flex flex-col gap-1.5 border-t border-border pt-4">
          {SCORED_DIMENSIONS.map((dimension) => (
            <li key={dimension} className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Check className="size-3.5 shrink-0 text-accent" />
              <span>{dimension} matched</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Every state this page can be in. Kept explicit rather than derived from a
 * grab-bag of booleans, because the whole point of the screen is that a user
 * without a resume, a user whose matches are weak, and a user hitting a broken
 * API each see a different, accurate message — and never a fabricated match.
 */
type Status = "loading" | "no-profile" | "no-preferences" | "ready" | "no-matches" | "error";

export default function RecommendedJobsPage() {
  const [status, setStatus] = useState<Status>("loading");
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [minScore, setMinScore] = useState(50);
  const [errorMsg, setErrorMsg] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  /* Fetch the caller's recommendations on mount, and again on every retry.
     Written as a promise chain rather than an awaited helper so every state
     update lands in a callback: an update on the synchronous path out of an
     effect cascades an extra render. */
  useEffect(() => {
    let isSubscribed = true;
    const controller = new AbortController();

    fetchRecommendations(controller.signal)
      .then((response) => {
        if (!isSubscribed) return;

        // null covers both "no token stored" and "the stored token no longer
        // resolves" — either way there is no profile, so prompt for a resume.
        if (response === null) {
          setStatus("no-profile");
          return;
        }

        setMinScore(response.meta.minScore);

        if (!response.meta.hasPreferences) {
          setStatus("no-preferences");
          return;
        }

        setRecommendations(response.data);
        setStatus(response.data.length > 0 ? "ready" : "no-matches");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !isSubscribed) return;

        setErrorMsg(error instanceof Error ? error.message : "An unexpected error occurred.");
        setStatus("error");
      });

    return () => {
      isSubscribed = false;
      controller.abort();
    };
  }, [retryKey]);

  /* Back to the skeleton while the retry runs, so the failed state does not sit
     there looking live. */
  const handleRetry = () => {
    setStatus("loading");
    setErrorMsg("");
    setRetryKey((key) => key + 1);
  };

  return (
    <main id="main">
      <section className="border-b border-border/70 bg-gradient-to-b from-surface to-background">
        <div className="mx-auto w-full max-w-6xl px-4 pt-14 pb-14 text-center sm:px-6 sm:pt-20 sm:pb-16 lg:px-8 lg:pt-24 lg:pb-20">
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
            <Sparkles className="size-3" aria-hidden="true" />
            Personalized
          </span>
          <h1 className="mt-4 font-heading text-3xl leading-tight font-semibold tracking-display text-balance text-foreground sm:text-4xl lg:text-5xl">
            Recommended Jobs
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            These jobs match the skills, roles and experience read from your uploaded resume —
            strongest match first.
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            <Link
              href="/profile"
              className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              Edit your profile
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-6xl px-4 pt-10 pb-16 sm:px-6 sm:pb-20 lg:px-8 lg:pb-24">
        {status === "loading" ? (
          <>
            <span className="sr-only" role="status">
              Loading your recommendations
            </span>
            <div className="grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <div
                  key={index}
                  className="flex h-72 animate-pulse flex-col justify-between rounded-lg border border-border bg-surface p-5 shadow-e1"
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
                    <div className="mt-4 h-3.5 w-5/6 rounded-sm bg-muted" />
                    <div className="mt-2 h-3.5 w-3/4 rounded-sm bg-muted" />
                  </div>
                  <div className="grid grid-cols-2 gap-2 border-t border-border pt-4">
                    <div className="h-11 rounded-md bg-muted pointer-fine:h-10" />
                    <div className="h-11 rounded-md bg-muted pointer-fine:h-10" />
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : status === "error" ? (
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center sm:py-12">
            <span
              aria-hidden="true"
              className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
            >
              <AlertCircle className="size-6" />
            </span>
            <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
              Unable to load recommendations
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
        ) : status === "no-profile" ? (
          <div className="rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center sm:py-14">
            <span
              aria-hidden="true"
              className="mx-auto grid size-11 place-items-center rounded-md border border-border bg-muted text-muted-foreground"
            >
              <FileUp className="size-5" />
            </span>
            <p className="mt-4 font-heading text-base font-semibold tracking-snug text-foreground">
              Upload your resume to get personalized job recommendations.
            </p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-subtle-foreground">
              We read your skills and preferences from it once, then match every new posting against
              them. You can edit everything afterwards.
            </p>
            <Link
              href="/profile"
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
            >
              <FileUp className="size-4" aria-hidden="true" />
              Upload your resume
            </Link>
          </div>
        ) : status === "no-preferences" ? (
          <div className="rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center sm:py-14">
            <span
              aria-hidden="true"
              className="mx-auto grid size-11 place-items-center rounded-md border border-border bg-muted text-muted-foreground"
            >
              <SlidersHorizontal className="size-5" />
            </span>
            <p className="mt-4 font-heading text-base font-semibold tracking-snug text-foreground">
              Your profile is empty
            </p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-subtle-foreground">
              Add at least a few skills or a preferred role, and matches will appear here.
            </p>
            <Link
              href="/profile"
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              Set your preferences
            </Link>
          </div>
        ) : status === "no-matches" ? (
          /* Nothing cleared the API's score threshold. Unrelated jobs are
             deliberately not shown here — the homepage feed is where browsing
             everything belongs. */
          <div className="rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center sm:py-14">
            <span
              aria-hidden="true"
              className="mx-auto grid size-11 place-items-center rounded-md border border-border bg-muted text-muted-foreground"
            >
              <SearchX className="size-5" />
            </span>
            <p className="mt-4 font-heading text-base font-semibold tracking-snug text-foreground">
              No matching jobs found
            </p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-subtle-foreground">
              Try updating your skills or check back when new opportunities are added.
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Link
                href="/profile"
                className="inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
              >
                <SlidersHorizontal className="size-4" aria-hidden="true" />
                Update preferences
              </Link>
              <Link
                href="/#opportunities"
                className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
              >
                Browse all opportunities
              </Link>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground tabular-nums">
                {recommendations.length}
              </span>{" "}
              {recommendations.length === 1 ? "match" : "matches"} scoring {minScore}% or higher.
            </p>
            <ul className="mt-6 grid gap-4 md:grid-cols-2 md:gap-5 xl:grid-cols-3">
              {recommendations.map((recommendation) => (
                <li key={recommendation.job.id} className="h-full">
                  <RecommendationCard recommendation={recommendation} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
