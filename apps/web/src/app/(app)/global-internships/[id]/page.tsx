"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Briefcase,
  Calendar,
  Clock,
  GraduationCap,
  Link2Off,
  MapPin,
} from "lucide-react";

import { CompanyLogo } from "@/components/company-logo";
import { LinkifiedText } from "@/components/linkified-text";
import { fetchGlobalInternship, type PublicJob } from "@/lib/api";
import { extractCleanJobDetails } from "@/lib/clean-job-content";
import { displayCompany, displayLocation, displayRole, formatPostedDate } from "@/lib/job-display";
import { resolveLink } from "@/lib/links";

export default function GlobalInternshipDetailPage() {
  const rawParams = useParams<{ id?: string | string[] }>();
  const rawId = rawParams.id;
  const params = { id: Array.isArray(rawId) ? rawId[0] ?? "" : rawId ?? "" };
  const [job, setJob] = useState<PublicJob | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!params.id) return;
    const controller = new AbortController();
    fetchGlobalInternship(params.id, controller.signal)
      .then(setJob)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Internship not found.");
        }
      });
    return () => controller.abort();
  }, [params.id]);

  if (!job && !error) {
    return (
      <PageShell>
        <div className="animate-pulse">
          <div className="flex items-start gap-3.5">
            <div className="size-12 shrink-0 rounded-md bg-muted sm:size-14" />
            <div className="min-w-0 flex-1">
              <div className="h-3.5 w-32 rounded-sm bg-muted" />
              <div className="mt-2.5 h-7 w-4/5 rounded-md bg-muted sm:h-8" />
            </div>
          </div>
          <div className="mt-6 h-11 w-full rounded-md bg-muted sm:w-40" />
        </div>
      </PageShell>
    );
  }

  if (!job) {
    return (
      <PageShell>
        <div className="py-10 text-center sm:py-14">
          <h1 className="text-xl font-semibold tracking-heading text-foreground">
            Internship unavailable
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {error}
          </p>
          <Link
            href="/global-internships"
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to Global Internships
          </Link>
        </div>
      </PageShell>
    );
  }

  const company = displayCompany(job);
  const role = displayRole(job);
  const apply = resolveLink(job.applyUrl);
  const location = displayLocation(job);
  const cleanDetails = extractCleanJobDetails(job);

  return (
    <PageShell>
      {/* ── Header: company, then role ── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="flex min-w-0 items-start gap-3.5">
          <CompanyLogo
            job={job}
            className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted font-heading text-lg font-semibold text-foreground sm:size-14 sm:text-xl"
          />
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-label text-primary uppercase">
              {company}
            </p>
            <h1 className="mt-1.5 text-2xl leading-tight font-semibold tracking-heading text-balance break-words text-foreground sm:text-[2rem]">
              {role}
            </h1>
          </div>
        </div>

        <span className="inline-flex w-max shrink-0 items-center gap-1.5 rounded-sm border border-border bg-muted px-3 py-1.5 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
          <GraduationCap className="size-3.5" aria-hidden="true" />
          Internship
        </span>
      </div>

      {/* ── Apply Action ── */}
      <div className="mt-6">
        {apply && job.applyUrlVerified ? (
          <a
            href={apply.href}
            {...(apply.kind === "email"
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" })}
            aria-label={
              apply.kind === "email"
                ? `Email ${apply.text} to apply for ${role} at ${company}`
                : `Apply for ${role} at ${company} (opens in a new tab)`
            }
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-7 text-[15px] font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2 sm:w-auto"
          >
            {apply.kind === "email" ? "Email to Apply" : "Apply Now"}
            <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
          </a>
        ) : (
          <p className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-muted/50 px-5 text-center text-sm font-medium text-subtle-foreground sm:w-auto">
            <Link2Off className="size-4 shrink-0" aria-hidden="true" />
            Application link not available
          </p>
        )}
      </div>

      {/* ── Job Details Grid ── */}
      <section
        className="mt-8 border-t border-border pt-6 sm:mt-9"
        aria-labelledby="job-details-heading"
      >
        <h2
          id="job-details-heading"
          className="font-heading text-base font-semibold tracking-snug text-foreground"
        >
          Internship Details
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {role ? (
            <DetailCard label="Role" icon={<Briefcase aria-hidden="true" />}>
              {role}
            </DetailCard>
          ) : null}

          {location ? (
            <DetailCard label="Location" icon={<MapPin aria-hidden="true" />}>
              <LinkifiedText text={location} />
            </DetailCard>
          ) : null}

          {job.batch ? (
            <DetailCard label="Batch" icon={<GraduationCap aria-hidden="true" />}>
              {job.batch}
            </DetailCard>
          ) : null}

          <DetailCard label="Posted" icon={<Clock aria-hidden="true" />}>
            {formatPostedDate(job.postedAt)}
          </DetailCard>

          {cleanDetails.eligibility ? (
            <DetailCard label="Eligibility" wide={needsFullWidth(cleanDetails.eligibility)}>
              <LinkifiedText text={cleanDetails.eligibility} />
            </DetailCard>
          ) : null}

          {cleanDetails.deadline ? (
            <DetailCard label="Last Date" icon={<Calendar aria-hidden="true" />}>
              <LinkifiedText text={cleanDetails.deadline} />
            </DetailCard>
          ) : null}

          {cleanDetails.salary ? (
            <DetailCard label="Compensation">
              <LinkifiedText text={cleanDetails.salary} />
            </DetailCard>
          ) : null}

          {cleanDetails.experience ? (
            <DetailCard label="Experience">
              <LinkifiedText text={cleanDetails.experience} />
            </DetailCard>
          ) : null}
        </div>
      </section>

      {/* ── Description ── */}
      {(cleanDetails.cleanDescription || cleanDetails.cleanBullets.length > 0) && (
        <section className="mt-8 border-t border-border pt-6" aria-labelledby="description-heading">
          <h2
            id="description-heading"
            className="font-heading text-base font-semibold tracking-snug text-foreground"
          >
            Description
          </h2>
          <div className="mt-4 space-y-3 text-sm leading-relaxed text-muted-foreground">
            {cleanDetails.cleanDescription && (
              <LinkifiedText text={cleanDetails.cleanDescription} />
            )}
            {cleanDetails.cleanBullets.length > 0 && (
              <ul className="space-y-2">
                {cleanDetails.cleanBullets.map((bullet, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span
                      className="mt-2 size-1.5 shrink-0 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                    <LinkifiedText text={bullet} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* ── Back link ── */}
      <div className="mt-8 border-t border-border pt-6">
        <BackButton />
      </div>
    </PageShell>
  );
}

/* ── Sub-components ───────────────────────────────────────────────────────── */

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      <div className="mb-5">
        <BackButton />
      </div>
      <div className="rounded-lg border border-border bg-surface p-5 shadow-e1 sm:p-8 lg:p-10">
        {children}
      </div>
    </div>
  );
}

function BackButton() {
  return (
    <Link
      href="/global-internships"
      className="group inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground pointer-fine:min-h-9"
    >
      <ArrowLeft
        className="size-4 shrink-0 transition-transform duration-150 group-hover:-translate-x-0.5"
        aria-hidden="true"
      />
      Back to Global Internships
    </Link>
  );
}

function DetailCard({
  label,
  icon,
  wide = false,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-md border border-border bg-background p-3.5${wide ? " sm:col-span-2" : ""}`}
    >
      <span className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
        {label}
      </span>
      <p className="mt-1 flex items-start gap-1.5 text-sm font-medium leading-relaxed text-foreground">
        {icon ? <span className="mt-0.5 shrink-0 text-primary [&>svg]:size-3.5">{icon}</span> : null}
        <span className="min-w-0 break-words">{children}</span>
      </p>
    </div>
  );
}

/** Keep concise values in the shared two-column rhythm; span only long prose. */
function needsFullWidth(value: string): boolean {
  return value.trim().length > 160;
}
