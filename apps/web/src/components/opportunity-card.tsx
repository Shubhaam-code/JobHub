"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Briefcase, Clock, GraduationCap, MapPin } from "lucide-react";

import { CompanyLogo } from "@/components/company-logo";
import { OPPORTUNITY_TYPE_LABELS } from "@/lib/opportunities";
import { resolveLink } from "@/lib/links";
import {
  displayCompany,
  displayLocation,
  displayRole,
  formatPostedDate,
  inferOpportunityType,
} from "@/lib/job-display";
import type { PublicJob } from "@/lib/api";

const TYPE_ICONS = {
  internship: GraduationCap,
  "full-time": Briefcase,
} as const;

/** The grid card, used on the homepage and anywhere jobs are shown as tiles. */
export function OpportunityCard({ opportunity }: { opportunity: PublicJob }) {
  const { batch, applyUrl, postedAt } = opportunity;

  const company = displayCompany(opportunity);
  const role = displayRole(opportunity);
  const location = displayLocation(opportunity);

  const type = inferOpportunityType(opportunity.role);
  const TypeIcon = TYPE_ICONS[type];
  const formattedPostedAt = formatPostedDate(postedAt);
  // An applyUrl is normally an http(s) link, but a stored email becomes mailto:
  // and anything with an unusable scheme is treated as absent.
  const applyLink = resolveLink(applyUrl);

  return (
    <article className="group relative flex h-full flex-col rounded-lg border border-border bg-surface p-5 shadow-e1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-e2 focus-within:border-primary">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {/* The company's logo when one was resolved during ingestion, and the
              monogram in the same tinted square when it was not. */}
          <CompanyLogo
            job={opportunity}
            className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-primary-soft font-heading text-[15px] leading-none font-semibold text-primary-strong"
          />
          {/* Company sits a step below the role on purpose: the role is what a
              reader scans a grid for, so the company is quieter rather than
              competing at the same weight. */}
          <span className="truncate text-[13px] font-medium text-muted-foreground">{company}</span>
        </div>

        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border bg-muted px-2 py-1 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
          <TypeIcon className="size-3" aria-hidden="true" />
          {OPPORTUNITY_TYPE_LABELS[type]}
        </span>
      </div>

      {/* Clamped to two lines so a long role cannot set the height of the whole
          grid row, without truncating so early that the title stops being
          readable. */}
      <h3 className="mt-4 line-clamp-2 text-lg leading-snug font-semibold tracking-snug text-balance text-foreground lg:text-xl">
        <Link
          href={`/jobs/${opportunity.id}`}
          className="rounded-sm before:absolute before:inset-0 before:rounded-lg before:content-['']"
        >
          {role}
        </Link>
      </h3>

      <ul className="mt-3.5 mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-subtle-foreground">
        {batch && (
          <li>
            <span className="inline-flex items-center rounded-sm bg-primary-soft px-2 py-1 text-xs font-semibold text-primary-strong tabular-nums">
              Batch {batch}
            </span>
          </li>
        )}
        {location && (
          <li className="inline-flex min-w-0 items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{location}</span>
          </li>
        )}
        <li className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{formattedPostedAt}</span>
        </li>
      </ul>

      {/* mt-auto pins this row to the card bottom; z-10 ensures buttons sit above
          the stretched-link overlay. Two equal columns so the action pair lands
          on the same grid line in every card — with no apply link, details takes
          the full width rather than leaving a gap where a button should be. */}
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
                ? `Email ${applyLink.text} to apply for ${role} at ${company}`
                : `Apply for ${role} at ${company} (opens in a new tab)`
            }
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            Apply Now
            <ArrowUpRight
              className="size-4 shrink-0 transition-transform duration-150 group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </a>
        ) : null}

        <Link
          href={`/jobs/${opportunity.id}`}
          aria-label={`View details for ${role} at ${company}`}
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
