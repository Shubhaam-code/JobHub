"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Briefcase, Check, Clock, GraduationCap, MapPin, Sparkles, Users } from "lucide-react";

import { CompanyLogo } from "@/components/company-logo";
import { OPPORTUNITY_TYPE_LABELS } from "@/lib/opportunities";
import {
  displayCompany,
  displayEmploymentType,
  displayLocation,
  displayRole,
  formatPostedDate,
  inferOpportunityType,
} from "@/lib/job-display";
import type { PublicJob } from "@/lib/api";
import type { CandidateProfile } from "@/lib/profile";
import { matchJob } from "@/lib/job-match";

const TYPE_ICONS = {
  internship: GraduationCap,
  "full-time": Briefcase,
} as const;

/** One compact listing card used by the Jobs page grid. */
export function JobListRow({ job, profile }: { job: PublicJob; profile: CandidateProfile | null }) {
  const company = displayCompany(job);
  const role = displayRole(job);
  const location = displayLocation(job);
  const employmentType = displayEmploymentType(job);

  const type = inferOpportunityType(job.role);
  const TypeIcon = TYPE_ICONS[type];
  const match = matchJob(profile, job);
  const [whyOpen, setWhyOpen] = useState(false);
  const matchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!whyOpen) return;
    const close = (event: MouseEvent) => {
      if (!matchRef.current?.contains(event.target as Node)) setWhyOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [whyOpen]);

  return (
    <article className="group relative flex h-full flex-col rounded-lg border border-border bg-surface p-5 shadow-e1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-e2 focus-within:border-primary">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CompanyLogo
            job={job}
            className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-primary-soft font-heading text-[15px] leading-none font-semibold text-primary-strong"
          />
          <p className="truncate text-[13px] font-medium text-muted-foreground">{company}</p>
        </div>
        <div className="relative flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setWhyOpen((open) => !open)}
            aria-expanded={whyOpen}
            className="hidden"
          >
            <Sparkles className="size-3" aria-hidden="true" />
            {match.score === null ? "AI Match: Not enough data" : `AI Match: ${match.score}% Match`}
          </button>
          {whyOpen && (
            <div className="hidden">
              <p className="text-xs font-semibold text-foreground">Why it matches?</p>
              {match.score === null ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Add profile skills or preferences to calculate a match.
                </p>
              ) : match.reasons.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {match.reasons.map((reason) => (
                    <li
                      key={reason}
                      className="flex items-start gap-1.5 text-xs text-muted-foreground"
                    >
                      <Check
                        className={`mt-0.5 size-3 shrink-0 ${reason.startsWith("✕") ? "text-destructive" : "text-primary"}`}
                        aria-hidden="true"
                      />
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No meaningful match found.</p>
              )}
            </div>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-muted px-2 py-1 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
            <TypeIcon className="size-3" aria-hidden="true" />
            {OPPORTUNITY_TYPE_LABELS[type]}
          </span>
        </div>
      </div>

      <h3 className="mt-4 line-clamp-2 text-lg leading-snug font-semibold tracking-snug text-balance text-foreground">
        <Link
          href={`/jobs/${job.id}`}
          className="rounded-sm before:absolute before:inset-0 before:rounded-lg before:content-['']"
        >
          {role}
        </Link>
      </h3>

      <ul className="mt-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-subtle-foreground">
        {location && (
          <li className="inline-flex min-w-0 items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{location}</span>
          </li>
        )}
        {employmentType && employmentType.toLowerCase() !== type && (
          <li className="inline-flex min-w-0 items-center gap-1.5">
            <Users className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{employmentType}</span>
          </li>
        )}
        {job.batch && (
          <li>
            <span className="inline-flex items-center rounded-sm bg-primary-soft px-2 py-1 text-xs font-semibold text-primary-strong tabular-nums">
              Batch {job.batch}
            </span>
          </li>
        )}
        <li className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{formatPostedDate(job.postedAt)}</span>
        </li>
      </ul>

      <div className="relative z-10 mt-auto grid gap-3 border-t border-border pt-4">
        <div ref={matchRef} className="relative">
          <button
            type="button"
            onClick={() => setWhyOpen((open) => !open)}
            aria-expanded={whyOpen}
            className="inline-flex items-center gap-1 rounded-sm border border-primary/20 bg-primary-soft px-2 py-1 text-[11px] font-semibold text-primary-strong"
          >
            <Sparkles className="size-3" aria-hidden="true" />
            {match.score === null ? "AI Match: Not enough data" : `AI Match: ${match.score}% Match`}
          </button>
          {whyOpen && (
            <div className="absolute bottom-full left-0 z-20 mb-2 w-64 rounded-md border border-border bg-surface p-3 text-left shadow-e2">
              <p className="text-xs font-semibold text-foreground">Why it matches?</p>
              {match.score === null ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Add profile skills or preferences to calculate a match.
                </p>
              ) : match.reasons.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {match.reasons.map((reason) => (
                    <li
                      key={reason}
                      className="flex items-start gap-1.5 text-xs text-muted-foreground"
                    >
                      <Check
                        className={`mt-0.5 size-3 shrink-0 ${reason.startsWith("✕") ? "text-destructive" : "text-primary"}`}
                        aria-hidden="true"
                      />
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">No meaningful match found.</p>
              )}
            </div>
          )}
        </div>
        <Link
          href={`/jobs/${job.id}`}
          aria-label={`View details for ${role} at ${company}`}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10 sm:flex-none"
        >
          Details
        </Link>
      </div>
    </article>
  );
}
