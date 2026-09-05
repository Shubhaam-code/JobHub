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
import { CompanyLogo } from "@/components/company-logo";

/**
 * Score bands, as a text treatment rather than a filled chip.
 *
 * The score is context for the card, not its call to action: a strong match
 * earns the brand hue as *text* over a whisper of tint, never a solid orange
 * block that outshouts the role it is describing. Weaker bands recede further.
 */
function scoreTone(score: number): string {
  if (score >= 80) return "border-primary/20 bg-primary/6 text-primary-strong";
  if (score >= 65) return "border-border bg-transparent text-muted-foreground";
  return "border-border bg-transparent text-subtle-foreground";
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
  const isInternship = /intern/i.test(job.employmentType ?? job.role ?? "");
  const TypeIcon = isInternship ? GraduationCap : Briefcase;

  // The stored apply link, resolved only for safety (mailto vs http) — never
  // rewritten or generated.
  const applyLink = resolveLink(job.applyUrl);
  
  // Show apply button only when URL exists AND is verified
  const showApplyButton = applyLink && job.applyUrlVerified;

  return (
    <article className="group relative flex h-full flex-col rounded-lg border border-border bg-surface p-5 shadow-e1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-e2 focus-within:border-primary">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CompanyLogo
            job={job}
            className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-lg border border-border bg-primary-soft font-heading text-[15px] leading-none font-semibold text-primary-strong transition-colors duration-200 group-hover:border-primary/40"
          />
          <span className="truncate text-[13px] font-medium text-muted-foreground">
            {displayCompany}
          </span>
        </div>

        {/* The reason this job is on screen — stated quietly, in lower case, so
            it reads as a note on the card rather than a badge competing with
            the role heading below it. */}
        <span
          className={`inline-flex shrink-0 items-center rounded-sm border px-2 py-0.5 text-[11px] font-medium tabular-nums ${scoreTone(matchScore)}`}
        >
          <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
          {matchScore}% match
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
              <Check className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
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
          showApplyButton ? "grid-cols-2" : "grid-cols-1"
        }`}
      >
        {showApplyButton ? (
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
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            Apply Now
            <ArrowUpRight
              className="size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </a>
        ) : applyLink ? (
          <div
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border bg-muted px-4 text-sm font-medium text-muted-foreground pointer-fine:min-h-10"
            title="Apply link verification in progress"
          >
            Apply link not available
          </div>
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
