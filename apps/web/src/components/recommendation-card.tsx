"use client";

import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Briefcase,
  Check,
  Clock,
  GraduationCap,
  MapPin,
} from "lucide-react";

import { resolveLink } from "@/lib/links";
import type { Recommendation } from "@/lib/profile";

/**
 * Score bands. The colour is a reading aid, not new visual design: it reuses the
 * accent (positive) and primary (neutral) tokens already in the palette.
 */
function scoreTone(score: number): string {
  if (score >= 80) return "border-accent/30 bg-accent/10 text-accent-strong";
  if (score >= 65) return "border-primary/30 bg-primary/10 text-primary-strong";
  return "border-border bg-muted text-muted-foreground";
}

function formatPostedDate(isoString: string): string {
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return "Recently";
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "Recently";
  }
}

/**
 * One recommended job.
 *
 * Same card anatomy as `OpportunityCard` — monogram, role heading, meta row,
 * action pair — with the match score and the engine's explanation added. The
 * reasons are rendered exactly as the API supplied them: they are computed by
 * the matcher, so the UI does not paraphrase or re-derive them.
 */
export function RecommendationCard({ recommendation }: { recommendation: Recommendation }) {
  const { job, matchScore, reasons, gaps } = recommendation;

  const displayCompany = job.company?.trim() || "Opportunity";
  const displayRole = job.role?.trim() || "Role not specified";
  const monogram = (job.company?.trim() || job.role?.trim() || "J").charAt(0).toUpperCase();
  const isInternship = /intern/i.test(job.employmentType ?? job.role ?? "");
  const TypeIcon = isInternship ? GraduationCap : Briefcase;

  // The stored apply link, resolved only for safety (mailto vs http) — never
  // rewritten or generated.
  const applyLink = resolveLink(job.applyUrl);

  return (
    <article className="group relative flex h-full flex-col rounded-lg border border-border bg-surface p-5 shadow-e1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-e2 focus-within:border-primary">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-muted font-heading text-[15px] leading-none font-semibold text-foreground transition-colors duration-200 group-hover:border-border-strong"
          >
            {monogram}
          </span>
          <span className="truncate text-[13px] font-medium text-muted-foreground">
            {displayCompany}
          </span>
        </div>

        {/* The score leads the card: it is the reason this job is on screen. */}
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-sm border px-2 py-1 text-[11px] font-semibold tracking-label uppercase tabular-nums ${scoreTone(matchScore)}`}
        >
          {matchScore}% Match
        </span>
      </div>

      <h3 className="mt-4 line-clamp-2 text-lg leading-snug font-semibold tracking-snug text-balance text-foreground lg:text-xl">
        <Link
          href={`/jobs/${job.id}`}
          className="rounded-sm before:absolute before:inset-0 before:rounded-lg before:content-['']"
        >
          {displayRole}
        </Link>
      </h3>

      <ul className="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-subtle-foreground">
        {job.batch && (
          <li>
            <span className="inline-flex items-center rounded-sm bg-primary/8 px-2 py-1 text-xs font-semibold text-primary tabular-nums">
              Batch {job.batch}
            </span>
          </li>
        )}
        {job.location && (
          <li className="inline-flex min-w-0 items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{job.location}</span>
          </li>
        )}
        <li className="inline-flex items-center gap-1.5">
          <TypeIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{isInternship ? "Internship" : "Full-Time"}</span>
        </li>
        <li className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{formatPostedDate(job.postedAt)}</span>
        </li>
      </ul>

      {/* Why it matched, straight from the matching engine. */}
      {reasons.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1.5">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-start gap-2 text-[13px] text-muted-foreground">
              <Check className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden="true" />
              <span>{reason}</span>
            </li>
          ))}
        </ul>
      )}

      {gaps.length > 0 && (
        <p className="mt-3 text-[13px] text-subtle-foreground">
          <span className="font-medium text-muted-foreground">Missing:</span> {gaps.join(", ")}
        </p>
      )}

      {/* mt-auto pins the action row to the card bottom so buttons line up
          across a grid row regardless of how many reasons each card shows. */}
      <div
        className={`relative z-10 mt-auto grid gap-2 border-t border-border pt-4 ${
          applyLink ? "grid-cols-2" : "grid-cols-1"
        }`}
      >
        {applyLink ? (
          <a
            href={applyLink.href}
            {...(applyLink.kind === "email"
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" })}
            aria-label={
              applyLink.kind === "email"
                ? `Email ${applyLink.text} to apply for ${displayRole} at ${displayCompany}`
                : `Apply for ${displayRole} at ${displayCompany} (opens in a new tab)`
            }
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-accent px-4 text-sm font-semibold text-on-accent shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-accent-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            Apply Now
            <ArrowUpRight
              className="size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </a>
        ) : null}

        <Link
          href={`/jobs/${job.id}`}
          aria-label={`View details for ${displayRole} at ${displayCompany}`}
          className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground active:scale-[0.98] pointer-fine:min-h-10"
        >
          View Details
          <ArrowRight
            className="size-3.5 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
            aria-hidden="true"
          />
        </Link>
      </div>
    </article>
  );
}
