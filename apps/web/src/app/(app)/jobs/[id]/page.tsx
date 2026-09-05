"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowUpRight,
  Briefcase,
  Calendar,
  Coins,
  GraduationCap,
  Link2Off,
  MapPin,
} from "lucide-react";

import { fetchJob, type PublicJob } from "@/lib/api";
import { cacheJob, readCachedJob } from "@/lib/job-cache";
import { CompanyLogo } from "@/components/company-logo";
import { LinkifiedText } from "@/components/linkified-text";
import { resolveLink } from "@/lib/links";
import {
  extractCleanJobDetails,
  isGenuineApplyLink,
} from "@/lib/clean-job-content";
import { DURATION, EASE_OUT } from "@/lib/motion";

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function inferType(role: string | null, explicitType?: string | null): "internship" | "full-time" {
  if (explicitType && /intern/i.test(explicitType)) return "internship";
  return role && /intern/i.test(role) ? "internship" : "full-time";
}

/* ── Component ────────────────────────────────────────────────────────────── */

export default function JobDetailPage() {
  const params = useParams();
  const id = typeof params["id"] === "string" ? params["id"] : "";

  /**
   * This job as loaded earlier in this session, when it is still fresh.
   *
   * Only seeds the state below — the effect reads the cache itself, so that a
   * store write never feeds back into this render as a changed dependency.
   */
  const cached = id ? readCachedJob(id) : null;

  const [job, setJob] = useState<PublicJob | null>(cached);
  const [status, setStatus] = useState<"loading" | "found" | "notfound" | "error">(
    cached ? "found" : id ? "loading" : "notfound",
  );
  const [errorMsg, setErrorMsg] = useState("");
  /** Bumped by "Try again" — the effect keys off it so a retry actually refetches. */
  const [retryKey, setRetryKey] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!id) return;

    abortRef.current?.abort();

    /* Already loaded and still fresh: show that copy instead of emptying the page
       for a request whose answer is here. Skipped once "Try again" has been
       pressed, so an explicit retry always goes back to the API. */
    const loaded = retryKey === 0 ? readCachedJob(id) : null;
    if (loaded) {
      setJob(loaded);
      setStatus("found");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;

    fetchJob(id, controller.signal)
      .then((data) => {
        cacheJob(data);
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

  // Structured extraction remains available only for the existing email CTA
  // fallback. The post body itself is rendered in source order below.
  const cleanDetails = extractCleanJobDetails(job);
  const type = inferType(cleanDetails.role || job.role, cleanDetails.employmentType);
  const TypeIcon = type === "internship" ? GraduationCap : Briefcase;
  const displayCompany = cleanDetails.company || job.company?.trim() || "Unknown company";
  const displayRole = cleanDetails.role || job.role?.trim() || "Role not specified";

  /* Resolve the application link, in the same order every card uses.
     `applyUrlVerified` is the gate: a stored link is only offered once discovery has
     proven it is this posting's own application page. Without that check an
     unverified link — an aggregator article, or a careers index that happens to
     parse as a URL — would be presented as "Apply Now" here even though the cards
     that link to this page hide it. An application email is a different kind of
     evidence: it comes from the post's own text, so it stands on its own. */
  const rawApply = resolveLink(job.applyUrl);
  const applyLink =
    job.applyUrlVerified && isGenuineApplyLink(rawApply)
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
          {/* Company logo when one was resolved, else the monogram — same box. */}
          <CompanyLogo
            job={job}
            className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md border border-border bg-muted font-heading text-lg font-semibold text-foreground sm:size-14 sm:text-xl"
          />
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
            Application link unavailable
          </p>
        )}
      </motion.div>

      {/* ── Job Details ── */}
      <motion.section
        {...reveal(3)}
        className="mt-8 border-t border-border pt-6 sm:mt-9"
        aria-labelledby="job-details-heading"
      >
        <h2
          id="job-details-heading"
          className="font-heading text-base font-semibold tracking-snug text-foreground"
        >
          Job Details
        </h2>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          {cleanDetails.role || job.role?.trim() ? (
            <DetailCard label="Role" icon={<Briefcase aria-hidden="true" />}>
              {cleanDetails.role || job.role?.trim()}
            </DetailCard>
          ) : null}

          {cleanDetails.location || job.location?.trim() ? (
            <DetailCard label="Location" icon={<MapPin aria-hidden="true" />}>
              <LinkifiedText text={cleanDetails.location || job.location?.trim()} />
            </DetailCard>
          ) : null}

          {cleanDetails.batch ? (
            <DetailCard label="Batch" icon={<GraduationCap aria-hidden="true" />}>
              <LinkifiedText text={cleanDetails.batch} />
            </DetailCard>
          ) : null}

          {cleanDetails.salary ? (
            <DetailCard label="Salary" icon={<Coins aria-hidden="true" />}>
              <LinkifiedText text={cleanDetails.salary} />
            </DetailCard>
          ) : null}

          {cleanDetails.experience ? (
            <DetailCard label="Experience">
              <LinkifiedText text={cleanDetails.experience} />
            </DetailCard>
          ) : null}

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
      href="/jobs"
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
    <div className={`rounded-md border border-border bg-background p-3.5${wide ? " sm:col-span-2" : ""}`}>
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
