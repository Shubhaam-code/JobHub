"use client";

import Link from "next/link";
import { ArrowUpRight, Briefcase, Clock, GraduationCap, MapPin, Users } from "lucide-react";

import { OPPORTUNITY_TYPE_LABELS } from "@/lib/opportunities";
import { resolveLink } from "@/lib/links";
import {
  displayCompany,
  displayEmploymentType,
  displayLocation,
  displayRole,
  formatPostedDate,
  inferOpportunityType,
  jobMonogram,
} from "@/lib/job-display";
import type { PublicJob } from "@/lib/api";

const TYPE_ICONS = {
  internship: GraduationCap,
  "full-time": Briefcase,
} as const;

/**
 * One listing as a full-width row — the shape the Jobs page uses.
 *
 * The same job as `OpportunityCard`, laid out for scanning a long list rather
 * than a grid: role first, then the facts that decide whether to open it, then
 * the action. There is deliberately no bookmark control: nothing in the API
 * stores a saved job, so the icon would be decoration that pretends to persist.
 */
export function JobListRow({ job }: { job: PublicJob }) {
  const company = displayCompany(job);
  const role = displayRole(job);
  const location = displayLocation(job);
  const employmentType = displayEmploymentType(job);
  const monogram = jobMonogram(job);

  const type = inferOpportunityType(job.role);
  const TypeIcon = TYPE_ICONS[type];
  const applyLink = resolveLink(job.applyUrl);

  return (
    <article className="group relative flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-e1 transition-[border-color,box-shadow] duration-200 hover:border-primary/40 hover:shadow-e2 focus-within:border-primary sm:flex-row sm:items-start sm:gap-5 sm:p-5">
      <span
        aria-hidden="true"
        className="grid size-12 shrink-0 place-items-center rounded-md bg-primary-soft font-heading text-lg leading-none font-semibold text-primary-strong"
      >
        {monogram}
      </span>

      <div className="min-w-0 flex-1">
        <h3 className="text-base leading-snug font-semibold tracking-snug text-foreground sm:text-lg">
          <Link
            href={`/jobs/${job.id}`}
            className="rounded-sm before:absolute before:inset-0 before:rounded-lg before:content-['']"
          >
            {role}
          </Link>
        </h3>
        <p className="mt-1 truncate text-sm font-medium text-muted-foreground">{company}</p>

        <ul className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-[13px] text-subtle-foreground">
          <li>
            <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-muted px-2 py-1 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
              <TypeIcon className="size-3" aria-hidden="true" />
              {OPPORTUNITY_TYPE_LABELS[type]}
            </span>
          </li>
          {/* Only when the source actually recorded one — see displayEmploymentType. */}
          {employmentType && employmentType.toLowerCase() !== type && (
            <li className="inline-flex min-w-0 items-center gap-1.5">
              <Users className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{employmentType}</span>
            </li>
          )}
          {location && (
            <li className="inline-flex min-w-0 items-center gap-1.5">
              <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="truncate">{location}</span>
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
      </div>

      {/* z-10 keeps these above the stretched link that covers the row. */}
      <div className="relative z-10 flex shrink-0 items-center gap-2 sm:flex-col sm:items-stretch">
        {applyLink ? (
          <a
            href={applyLink.href}
            {...(applyLink.kind === "email"
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" })}
            aria-label={
              applyLink.kind === "email"
                ? `Email ${applyLink.text} to apply for ${role} at ${company}`
                : `Apply for ${role} at ${company} (opens in a new tab)`
            }
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10 sm:flex-none"
          >
            Apply Now
            <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
          </a>
        ) : null}

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
