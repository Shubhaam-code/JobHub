"use client";

import { Lightbulb } from "lucide-react";

import { CardSkeleton, ErrorPanel } from "@/components/panels";
import { ResumeSummaryCard, ResumeUploadCard } from "@/components/resume-upload-card";
import { useCandidateProfile } from "@/lib/use-candidate-profile";

/**
 * What the parser can and cannot read, phrased as advice.
 *
 * These are facts about the pipeline, not filler: it reads text from a PDF, so a
 * scanned image has nothing to read; it matches on skill names, so the skills
 * have to be written down; and it scores against roles and locations, so those
 * lines matter.
 */
const TIPS = [
  "Export a text PDF, not a scan or a screenshot — the parser reads the text layer.",
  "List your skills by name. Those names are what job descriptions are matched against.",
  "Name the roles you want. A clear title beats a paragraph describing one.",
  "Include your location, or write “Remote” if that is what you are after.",
  "Keep it to the work that is relevant. Everything you list gets weighed.",
];

export default function DashboardResumePage() {
  const { status, profile, error, reload, adopt } = useCandidateProfile();

  const hasResume = profile?.hasResume === true;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-heading text-2xl leading-tight font-semibold tracking-display text-foreground sm:text-3xl">
          Upload Resume
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
          One PDF is all it takes. We read your skills, roles and locations out of it and score every
          opening against them.
        </p>
      </header>

      {status === "loading" ? (
        <>
          <span className="sr-only" role="status">
            Loading your profile
          </span>
          <CardSkeleton className="h-80" />
        </>
      ) : status === "error" ? (
        <ErrorPanel title="Unable to load your profile" message={error} onRetry={reload} />
      ) : (
        <>
          <ResumeUploadCard profile={profile} onUploaded={adopt} />

          {hasResume && profile !== null && <ResumeSummaryCard profile={profile} />}

          <section className="rounded-lg border border-border bg-primary-soft/50 p-5 sm:p-6">
            <h2 className="inline-flex items-center gap-2 font-heading text-base font-semibold tracking-heading text-foreground">
              <Lightbulb className="size-4 text-primary-strong" aria-hidden="true" />
              Resume Tips
            </h2>
            <ul className="mt-3 flex flex-col gap-2">
              {TIPS.map((tip) => (
                <li
                  key={tip}
                  className="flex items-start gap-2.5 text-sm leading-relaxed text-muted-foreground"
                >
                  <span
                    aria-hidden="true"
                    className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                  />
                  {tip}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
