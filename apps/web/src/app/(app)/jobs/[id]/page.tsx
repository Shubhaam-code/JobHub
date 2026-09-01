"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowUpRight,
  Briefcase,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  Coins,
  GraduationCap,
  Link2Off,
  Mail,
  MapPin,
} from "lucide-react";

import { fetchJob, type PublicJob } from "@/lib/api";
import { LinkifiedText } from "@/components/linkified-text";
import { resolveLink } from "@/lib/links";
import {
  extractCleanJobDetails,
  isGenuineApplyLink,
  type CleanJobDetails,
} from "@/lib/clean-job-content";
import { DURATION, EASE_OUT } from "@/lib/motion";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function formatDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return "Unknown date";
    return d.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return "Unknown date";
  }
}

function inferType(role: string | null, explicitType?: string | null): "internship" | "full-time" {
  if (explicitType && /intern/i.test(explicitType)) return "internship";
  return role && /intern/i.test(role) ? "internship" : "full-time";
}

/* ── Component ────────────────────────────────────────────────────────────── */

export default function JobDetailPage() {
  const params = useParams();
  const id = typeof params["id"] === "string" ? params["id"] : "";

  const [job, setJob] = useState<PublicJob | null>(null);
  const [status, setStatus] = useState<"loading" | "found" | "notfound" | "error">(
    id ? "loading" : "notfound",
  );
  const [errorMsg, setErrorMsg] = useState("");
  /** Bumped by "Try again" — the effect keys off it so a retry actually refetches. */
  const [retryKey, setRetryKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!id) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    fetchJob(id, controller.signal)
      .then((data) => {
        setJob(data);
        setStatus("found");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const isNotFound =
          err instanceof Error && (err as Error & { status?: number }).status === 404;
        if (isNotFound) {
          setStatus("notfound");
        } else {
          setStatus("error");
          setErrorMsg(err instanceof Error ? err.message : "An unexpected error occurred.");
        }
      });

    return () => controller.abort();
  }, [id, retryKey]);

  /** Entrance reveal, ordered top-to-bottom. Mirrors the homepage hero pattern. */
  const reveal = (order: number) => ({
    initial: reduceMotion ? false : { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    transition: {
      duration: DURATION.enter,
      delay: reduceMotion ? 0 : order * 0.06,
      ease: EASE_OUT,
    },
  });

  /* ── Loading ── */
  if (status === "loading") {
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
          <div className="mt-6 flex gap-8 border-y border-border py-4">
            <div>
              <div className="h-2.5 w-10 rounded-sm bg-muted" />
              <div className="mt-2 h-4 w-16 rounded-sm bg-muted" />
            </div>
            <div>
              <div className="h-2.5 w-12 rounded-sm bg-muted" />
              <div className="mt-2 h-4 w-28 rounded-sm bg-muted" />
            </div>
          </div>
          <div className="mt-6 h-11 w-full rounded-md bg-muted sm:w-40" />
          <div className="mt-8 space-y-2.5 rounded-lg border border-border bg-background p-4 sm:p-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <div
                key={i}
                className="h-4 rounded-sm bg-muted"
                style={{ width: `${88 - i * 11}%` }}
              />
            ))}
          </div>
        </div>
      </PageShell>
    );
  }

  /* ── Not found ── */
  if (status === "notfound") {
    return (
      <PageShell>
        <div className="py-10 text-center sm:py-14">
          <p className="font-heading text-5xl font-semibold tracking-display text-border-strong">
            404
          </p>
          <h1 className="mt-4 text-xl font-semibold tracking-heading text-foreground">
            Job not found
          </h1>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            This listing may have been removed or the ID is invalid.
          </p>
          <Link
            href="/#jobs"
            className="mt-6 inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            Browse opportunities
          </Link>
        </div>
      </PageShell>
    );
  }

  /* ── Error ── */
  if (status === "error") {
    return (
      <PageShell>
        <div className="py-10 text-center sm:py-14">
          <h1 className="text-xl font-semibold tracking-heading text-foreground">
            Something went wrong
          </h1>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {errorMsg}
          </p>
          <button
            type="button"
            onClick={() => {
              setStatus("loading");
              setErrorMsg("");
              setRetryKey((key) => key + 1);
            }}
            className="mt-6 inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            Try again
          </button>
        </div>
      </PageShell>
    );
  }

  /* ── Found ── */
  if (!job) return null;

  const cleanDetails: CleanJobDetails = extractCleanJobDetails(job);
  const type = inferType(cleanDetails.role || job.role, cleanDetails.employmentType);
  const TypeIcon = type === "internship" ? GraduationCap : Briefcase;
  const displayCompany = cleanDetails.company || job.company?.trim() || "Unknown company";
  const displayRole = cleanDetails.role || job.role?.trim() || "Role not specified";
  const monogram = (displayCompany || displayRole || "J").charAt(0).toUpperCase();

  // Resolve genuine application link. Use applyUrl or application email.
  const rawApply = resolveLink(job.applyUrl);
  const applyLink = isGenuineApplyLink(rawApply)
    ? rawApply
    : cleanDetails.applyEmail
      ? {
          kind: "email" as const,
          text: cleanDetails.applyEmail,
          href: `mailto:${cleanDetails.applyEmail}`,
        }
      : null;

  return (
    <PageShell>
      {/* ── Header: company, then role as the page's anchor ── */}
      <motion.div
        {...reveal(0)}
        className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
      >
        <div className="flex min-w-0 items-start gap-3.5">
          <span
            aria-hidden="true"
            className="grid size-12 shrink-0 place-items-center rounded-md border border-border bg-muted font-heading text-lg font-semibold text-foreground sm:size-14 sm:text-xl"
          >
            {monogram}
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-label text-primary uppercase">
              {displayCompany}
            </p>
            <h1 className="mt-1.5 text-2xl leading-tight font-semibold tracking-heading text-balance break-words text-foreground sm:text-[2rem]">
              {displayRole}
            </h1>
          </div>
        </div>

        <span className="inline-flex w-max shrink-0 items-center gap-1.5 rounded-sm border border-border bg-muted px-3 py-1.5 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
          <TypeIcon className="size-3.5" aria-hidden="true" />
          {cleanDetails.employmentType
            ? cleanDetails.employmentType.charAt(0).toUpperCase() +
              cleanDetails.employmentType.slice(1)
            : type === "internship"
              ? "Internship"
              : "Full-time"}
        </span>
      </motion.div>

      {/* ── Key Metadata Specification Sheet ── */}
      <motion.dl
        {...reveal(1)}
        className="mt-6 flex flex-wrap gap-x-8 gap-y-4 border-y border-border py-4 sm:mt-7"
      >
        {cleanDetails.batch && (
          <div>
            <dt className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
              Batch
            </dt>
            <dd className="mt-1 text-sm font-semibold text-primary tabular-nums">
              {cleanDetails.batch}
            </dd>
          </div>
        )}
        {cleanDetails.location && (
          <div>
            <dt className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
              Location
            </dt>
            <dd className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-foreground">
              <MapPin className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
              <span>
                <LinkifiedText text={cleanDetails.location} />
              </span>
            </dd>
          </div>
        )}
        {cleanDetails.salary && (
          <div>
            <dt className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
              Compensation
            </dt>
            <dd className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-foreground">
              <Coins className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
              <span>
                <LinkifiedText text={cleanDetails.salary} />
              </span>
            </dd>
          </div>
        )}
        {cleanDetails.experience && (
          <div>
            <dt className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
              Experience
            </dt>
            <dd className="mt-1 text-sm font-medium text-foreground">
              <LinkifiedText text={cleanDetails.experience} />
            </dd>
          </div>
        )}
        <div>
          <dt className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
            Posted
          </dt>
          <dd className="mt-1 inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Clock className="size-3.5 shrink-0 text-subtle-foreground" aria-hidden="true" />
            <span className="tabular-nums">{formatDate(job.postedAt)}</span>
          </dd>
        </div>
      </motion.dl>

      {/* ── Action: Apply Link ── */}
      <motion.div {...reveal(2)} className="mt-6">
        {applyLink ? (
          <motion.a
            href={applyLink.href}
            {...(applyLink.kind === "email"
              ? {}
              : { target: "_blank", rel: "noopener noreferrer" })}
            aria-label={
              applyLink.kind === "email"
                ? `Email ${applyLink.text} to apply for ${displayRole} at ${displayCompany}`
                : `Apply for ${displayRole} at ${displayCompany} (opens in a new tab)`
            }
            whileHover={reduceMotion ? undefined : { y: -1 }}
            whileTap={reduceMotion ? undefined : { scale: 0.985 }}
            transition={{ duration: DURATION.press, ease: EASE_OUT }}
            className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md bg-primary px-7 text-[15px] font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2 sm:w-auto"
          >
            {applyLink.kind === "email" ? "Email to Apply" : "Apply Now"}
            <ArrowUpRight className="size-4 shrink-0" aria-hidden="true" />
          </motion.a>
        ) : (
          <p className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-dashed border-border-strong bg-muted/50 px-5 text-center text-sm font-medium text-subtle-foreground sm:w-auto">
            <Link2Off className="size-4 shrink-0" aria-hidden="true" />
            No application link available
          </p>
        )}
      </motion.div>

      {/* ── Clean Job Details Section ── */}
      <motion.section
        {...reveal(3)}
        className="mt-8 border-t border-border pt-6 sm:mt-9"
        aria-labelledby="job-details-heading"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2
            id="job-details-heading"
            className="font-heading text-base font-semibold tracking-snug text-foreground"
          >
            Job Details
          </h2>
        </div>

        <div className="mt-4 space-y-4">
          {/* Structured specs cards */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-border bg-background p-3.5">
              <span className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                Company
              </span>
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Building2 className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                {displayCompany}
              </p>
            </div>

            <div className="rounded-md border border-border bg-background p-3.5">
              <span className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                Role
              </span>
              <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Briefcase className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                {displayRole}
              </p>
            </div>

            {cleanDetails.eligibility && (
              <div className="rounded-md border border-border bg-background p-3.5 sm:col-span-2">
                <span className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                  Eligibility & Qualifications
                </span>
                <p className="mt-1 text-sm font-medium leading-relaxed text-foreground">
                  <LinkifiedText text={cleanDetails.eligibility} />
                </p>
              </div>
            )}

            {cleanDetails.skills && (
              <div className="rounded-md border border-border bg-background p-3.5 sm:col-span-2">
                <span className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                  Required Skills
                </span>
                <p className="mt-1 text-sm font-medium leading-relaxed text-foreground">
                  <LinkifiedText text={cleanDetails.skills} />
                </p>
              </div>
            )}

            {cleanDetails.deadline && (
              <div className="rounded-md border border-border bg-background p-3.5">
                <span className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                  Application Deadline
                </span>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Calendar className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                  <LinkifiedText text={cleanDetails.deadline} />
                </p>
              </div>
            )}

            {cleanDetails.applyEmail && (
              <div className="rounded-md border border-border bg-background p-3.5">
                <span className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
                  Contact / Apply Email
                </span>
                <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <Mail className="size-3.5 text-primary shrink-0" aria-hidden="true" />
                  <a
                    href={`mailto:${cleanDetails.applyEmail}`}
                    className="font-medium text-primary underline decoration-primary/35 underline-offset-2 hover:text-primary-strong hover:decoration-primary"
                  >
                    {cleanDetails.applyEmail}
                  </a>
                </p>
              </div>
            )}
          </div>

          {/* Clean bullet points if present */}
          {cleanDetails.cleanBullets.length > 0 && (
            <div className="rounded-md border border-border bg-background p-4 sm:p-5">
              <h3 className="mb-3 text-[13px] font-semibold tracking-label text-subtle-foreground uppercase">
                Highlights & Requirements
              </h3>
              <ul className="space-y-2 text-sm leading-relaxed text-muted-foreground">
                {cleanDetails.cleanBullets.map((bullet, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                    <span className="min-w-0">
                      <LinkifiedText text={bullet} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Clean description paragraphs if present */}
          {cleanDetails.cleanDescription && (
            <div className="rounded-md border border-border bg-background p-4 sm:p-5 font-body text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap">
              <LinkifiedText text={cleanDetails.cleanDescription} />
            </div>
          )}
        </div>
      </motion.section>

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

function BackButton({ className }: { className?: string }) {
  return (
    <Link
      href="/#jobs"
      className={`group inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground pointer-fine:min-h-9 ${className ?? ""}`}
    >
      <ArrowLeft
        className="size-4 shrink-0 transition-transform duration-150 group-hover:-translate-x-0.5"
        aria-hidden="true"
      />
      Back to Opportunities
    </Link>
  );
}
