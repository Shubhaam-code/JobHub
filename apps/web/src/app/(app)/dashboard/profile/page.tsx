"use client";

import Link from "next/link";
import { FileUp } from "lucide-react";

import { CardSkeleton, ErrorPanel } from "@/components/panels";
import { ProfilePreferencesForm } from "@/components/profile-preferences-form";
import { useCandidateProfile } from "@/lib/use-candidate-profile";

/**
 * Profile settings — the preferences a job is scored against.
 *
 * There is nothing to edit until a resume has been parsed: the API mints the
 * profile token on that first upload, so before it there is no profile for a save
 * to authenticate against. That is why the empty state sends you to the upload
 * screen rather than showing a form whose Save button could only ever fail.
 */
export default function DashboardProfilePage() {
  const { status, profile, error, reload, adopt } = useCandidateProfile();

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-heading text-2xl leading-tight font-semibold tracking-display text-foreground sm:text-3xl">
          Profile Settings
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">
          Read from your resume, and yours to correct. Anything you edit here is kept as-is by later
          uploads.
        </p>
      </header>

      {status === "loading" ? (
        <>
          <span className="sr-only" role="status">
            Loading your profile
          </span>
          <CardSkeleton className="h-96" />
        </>
      ) : status === "error" ? (
        <ErrorPanel title="Unable to load your profile" message={error} onRetry={reload} />
      ) : status === "empty" || profile === null ? (
        <div className="rounded-lg border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-11 place-items-center rounded-md bg-primary-soft text-primary-strong"
          >
            <FileUp className="size-5" />
          </span>
          <p className="mt-4 font-heading text-base font-semibold tracking-snug text-foreground">
            No profile yet
          </p>
          <p className="mx-auto mt-1.5 max-w-sm text-sm leading-relaxed text-subtle-foreground">
            Upload a resume first. Your skills and preferences are read from it, and you can edit
            every one of them here afterwards.
          </p>
          <Link
            href="/dashboard/resume"
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            <FileUp className="size-4" aria-hidden="true" />
            Upload your resume
          </Link>
        </div>
      ) : (
        /* Remounted when a different profile arrives (a new resume was parsed), so
           the fields reseed from it instead of being synchronised by an effect. */
        <ProfilePreferencesForm
          key={profile.resumeParsedAt ?? "manual"}
          profile={profile}
          onSaved={adopt}
        />
      )}
    </div>
  );
}
