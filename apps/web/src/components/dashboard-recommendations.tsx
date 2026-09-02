"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

import { InlineLoading } from "@/components/panels";
import { RecommendationCard } from "@/components/recommendation-card";
import { errorText, fetchRecommendations, type Recommendation } from "@/lib/profile";

/** Three across on the widest layout, matching the reference row. */
const LIMIT = 3;

type Status = "loading" | "no-profile" | "ready" | "empty" | "error";

/**
 * "Recommended for you" — the top few real matches, scored by the API.
 *
 * Every card here comes from `GET /api/v1/jobs/recommended`, which scores stored
 * jobs against the caller's parsed profile. When there is no profile, or nothing
 * clears the API's score threshold, this section says so rather than filling the
 * row with unrelated jobs.
 */
export function DashboardRecommendations() {
  const [status, setStatus] = useState<Status>("loading");
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let subscribed = true;
    const controller = new AbortController();

    fetchRecommendations(controller.signal, LIMIT)
      .then((response) => {
        if (!subscribed) return;

        if (response === null) {
          setStatus("no-profile");
          return;
        }

        if (!response.meta.hasPreferences) {
          setStatus("no-profile");
          return;
        }

        setRecommendations(response.data);
        setStatus(response.data.length > 0 ? "ready" : "empty");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || !subscribed) return;
        setError(errorText(caught));
        setStatus("error");
      });

    return () => {
      subscribed = false;
      controller.abort();
    };
  }, []);

  return (
    <section>
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <h2 className="inline-flex items-center gap-1.5 font-heading text-base font-semibold tracking-heading text-foreground sm:gap-2 sm:text-lg">
          <Sparkles className="size-3.5 text-primary sm:size-4" aria-hidden="true" />
          Recommended for you
        </h2>
        {/* Shares the heading row with "View all" — the two never coexist, so the
            wait costs no extra height and the row does not reflow when the
            matches land. */}
        {status === "loading" && <InlineLoading label="Looking for your recommended jobs…" />}
        {status === "ready" && (
          <Link
            href="/recommended-jobs"
            className="inline-flex min-h-8 items-center gap-1 rounded-sm text-xs font-semibold text-primary-strong underline-offset-2 hover:underline sm:min-h-9 sm:gap-1.5 sm:text-sm"
          >
            View all
            <ArrowRight className="size-3 sm:size-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>

      {status === "loading" ? (
        <div className="mt-3 grid gap-3 sm:mt-4 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
          {Array.from({ length: LIMIT }).map((_, index) => (
            <div
              key={index}
              className="h-56 animate-pulse rounded-lg border border-border bg-surface shadow-e1 sm:h-64"
            />
          ))}
        </div>
      ) : status === "no-profile" ? (
        <p className="mt-3 rounded-lg border border-dashed border-border-strong bg-surface px-4 py-6 text-center text-xs leading-relaxed text-subtle-foreground sm:mt-4 sm:px-5 sm:py-8 sm:text-sm">
          Upload your resume above and your matches will appear here.
        </p>
      ) : status === "empty" ? (
        <p className="mt-3 rounded-lg border border-dashed border-border-strong bg-surface px-4 py-6 text-center text-xs leading-relaxed text-subtle-foreground sm:mt-4 sm:px-5 sm:py-8 sm:text-sm">
          Nothing has cleared the match threshold yet.{" "}
          <Link href="/jobs" className="font-medium text-primary-strong underline">
            Browse all jobs
          </Link>{" "}
          in the meantime.
        </p>
      ) : status === "error" ? (
        <p
          role="alert"
          className="mt-3 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-destructive sm:mt-4 sm:px-4 sm:py-3 sm:text-sm"
        >
          {error}
        </p>
      ) : (
        <ul className="mt-3 grid gap-3 sm:mt-4 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
          {recommendations.map((recommendation) => (
            <li key={recommendation.job.id} className="h-full">
              <RecommendationCard recommendation={recommendation} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
