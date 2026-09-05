"use client";

import { ArrowUpRight, Clock, GraduationCap, MapPin } from "lucide-react";

import { CompanyLogo } from "@/components/company-logo";
import { extractCleanJobDetails } from "@/lib/clean-job-content";
import { resolveLink } from "@/lib/links";
import { displayCompany, displayLocation, displayRole, formatPostedDate } from "@/lib/job-display";
import type { PublicJob } from "@/lib/api";

/**
 * Compact card for the GitHub-backed feed.
 *
 * The regular opportunity card stays unchanged because this feed has a
 * narrower set of source fields. In particular, the role is allowed to wrap
 * naturally instead of being clamped, while optional source details are only
 * rendered when the description contains something useful.
 *
 * There is deliberately no detail-page link. Everything this source gives us is
 * already on the card, so a detail page would only add a hop between the reader
 * and the employer's application — the card's one action is Apply.
 */
export function GlobalInternshipCard({ opportunity }: { opportunity: PublicJob }) {
  const company = displayCompany(opportunity);
  const role = displayRole(opportunity);
  const postedDate = formatPostedDate(opportunity.postedAt);
  const applyLink = resolveLink(opportunity.applyUrl);
  
  // Show apply button only when URL exists AND is verified
  const showApplyButton = applyLink && opportunity.applyUrlVerified;
  
  const details = extractCleanJobDetails(opportunity);
  const location = displayLocation(opportunity) ?? details.location;
  const supplementalDetails = [
    details.eligibility ? { label: "Eligibility", value: details.eligibility } : null,
    details.deadline ? { label: "Apply by", value: details.deadline } : null,
  ].filter((detail): detail is { label: string; value: string } => detail !== null);
  const hasDescription = Boolean(details.cleanDescription || details.cleanBullets.length > 0);

  return (
    <article className="group relative flex h-full flex-col rounded-lg border border-border bg-surface p-5 shadow-e1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-e2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <CompanyLogo
            job={opportunity}
            className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-primary-soft font-heading text-[15px] leading-none font-semibold text-primary-strong"
          />
          <span className="truncate text-[13px] font-medium text-muted-foreground">{company}</span>
        </div>

        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-border bg-muted px-2 py-1 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
          <GraduationCap className="size-3" aria-hidden="true" />
          Internship
        </span>
      </div>

      {/* Clamped to two lines so long roles don't break grid alignment */}
      <h3 className="mt-4 line-clamp-2 text-lg leading-snug font-semibold tracking-snug text-balance text-foreground lg:text-xl">
        {role}
      </h3>

      <ul className="mt-3.5 mb-5 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[13px] text-subtle-foreground">
        {location && (
          <li className="inline-flex min-w-0 items-center gap-1.5">
            <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">{location}</span>
          </li>
        )}
        <li className="inline-flex items-center gap-1.5">
          <Clock className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="tabular-nums">{postedDate}</span>
        </li>
      </ul>

      {hasDescription && (
        <div className="mb-3 border-t border-border pt-3.5">
          {details.cleanDescription && (
            <p className="line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
              {details.cleanDescription}
            </p>
          )}
          {details.cleanBullets.length > 0 && (
            <ul className="mt-2 flex flex-col gap-1 text-[13px] leading-relaxed text-muted-foreground">
              {details.cleanBullets.slice(0, 2).map((bullet, index) => (
                <li key={index} className="flex items-start gap-2 line-clamp-1">
                  <span
                    className="mt-2 size-1 shrink-0 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                  <span className="truncate">{bullet}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {supplementalDetails.length > 0 && (
        <dl className="mb-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[12px] leading-relaxed text-subtle-foreground">
          {supplementalDetails.map((detail) => (
            <div key={detail.label} className="min-w-0">
              <dt className="inline font-semibold text-muted-foreground">{detail.label}: </dt>
              <dd className="inline truncate">{detail.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {/* mt-auto pins the button to card bottom. One column, not two: this feed's
          only action is applying at the source, so there is no detail page to
          offer beside it. */}
      <div className="relative z-10 mt-auto grid grid-cols-1 gap-2 border-t border-border pt-4">
        {showApplyButton ? (
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
        ) : (
          <div
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border border-border bg-muted px-4 text-sm font-medium text-muted-foreground pointer-fine:min-h-10"
            title="Apply link verification in progress"
          >
            Apply link not available
          </div>
        )}

      </div>
    </article>
  );
}
