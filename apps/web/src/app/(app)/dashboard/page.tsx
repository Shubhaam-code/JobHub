"use client";

import { DashboardGreeting } from "@/components/dashboard-greeting";
import { DashboardRecommendations } from "@/components/dashboard-recommendations";
import { CardSkeleton, ErrorPanel } from "@/components/panels";
import { ResumeSummaryCard, ResumeUploadCard } from "@/components/resume-upload-card";
import { useCandidateProfile } from "@/lib/use-candidate-profile";

/**
 * The user dashboard's overview.
 *
 * Resume first, then matches — the same order as the reference, and the order the
 * feature actually works in: the profile only exists once a resume has been
 * parsed, and matches are scored against that profile.
 */
export default function DashboardPage() {
  const { status, profile, error, reload, adopt } = useCandidateProfile();

  const hasResume = profile?.hasResume === true;

  return (
    <div className="flex flex-col gap-8">
      <DashboardGreeting subtitle="Upload your resume, keep your preferences current, and see the openings that match you." />

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
          <div className={hasResume ? "grid gap-6 xl:grid-cols-2" : undefined}>
            <ResumeUploadCard profile={profile} onUploaded={adopt} />
            {/* Only once there is one — otherwise this card would describe a
                resume that has never been uploaded. */}
            {hasResume && profile !== null && <ResumeSummaryCard profile={profile} />}
          </div>

          {/* Remounted when a new resume is parsed, so the row re-scores against
              the profile that upload just produced. */}
          <DashboardRecommendations key={profile?.resumeParsedAt ?? "no-profile"} />
        </>
      )}
    </div>
  );
}
