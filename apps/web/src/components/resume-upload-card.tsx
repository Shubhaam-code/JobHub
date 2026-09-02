"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  CloudUpload,
  FileText,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";

import { errorText, uploadResume, type CandidateProfile } from "@/lib/profile";

/** Well under the API's own limit, but enough to stop an obvious mistake early. */
const MAX_BYTES = 10 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string | null): string | null {
  if (value === null) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  /* Pinned to UTC so the server render and the browser agree — a locale-local
     date would differ between them and trip hydration. */
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** PDF only, because the API parses PDF and nothing else. */
function rejectionReason(file: File): string | null {
  const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  if (!isPdf) return "That file is not a PDF. Export your resume as a PDF and try again.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_BYTES) return `That file is ${formatBytes(file.size)}. The limit is 10 MB.`;
  return null;
}

/**
 * Resume upload: drop zone, file picker, and the real POST.
 *
 * The PDF goes straight to `POST /api/v1/profile/resume`, which parses it, stores
 * the fields it read and — on a first upload — returns the token that identifies
 * the profile from then on. The file itself is not kept anywhere, which is why
 * the card says so rather than implying a stored copy.
 */
export function ResumeUploadCard({
  profile,
  onUploaded,
}: {
  profile: CandidateProfile | null;
  onUploaded: (next: CandidateProfile) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const hasResume = profile?.hasResume === true;

  const accept = (picked: File | null | undefined) => {
    setDone(false);

    if (!picked) return;

    const reason = rejectionReason(picked);
    if (reason !== null) {
      setFile(null);
      setError(reason);
      return;
    }

    setFile(picked);
    setError("");
  };

  const clearPick = () => {
    setFile(null);
    setError("");
    // The input keeps its own value; clearing it is what lets the same file be
    // picked again after a failure.
    if (inputRef.current !== null) inputRef.current.value = "";
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (uploading || file === null) return;

    setUploading(true);
    setError("");
    setDone(false);

    try {
      const result = await uploadResume(file);

      onUploaded(result);
      clearPick();
      setDone(true);
    } catch (caught: unknown) {
      setError(errorText(caught));
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-surface p-4 shadow-e1 sm:p-5 lg:p-6"
    >
      <h2 className="font-heading text-base font-semibold tracking-heading text-foreground sm:text-lg">
        {hasResume ? "Replace Your Resume" : "Upload Your Resume"}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-subtle-foreground sm:text-sm">
        We read your skills and preferences from it once, then match every new posting against them.
      </p>

      {/* A label rather than a div with a click handler: the whole zone becomes
          the file input's own control, so keyboard and screen-reader users get the
          picker without a second, parallel affordance. */}
      <label
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer.files?.[0]);
        }}
        className={`mt-4 flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors duration-150 sm:mt-5 sm:px-6 sm:py-10 ${
          dragging
            ? "border-primary bg-primary-soft"
            : "border-border-strong bg-background hover:border-primary/60 hover:bg-primary-soft/40"
        }`}
      >
        <span
          aria-hidden="true"
          className="grid size-10 place-items-center rounded-full bg-primary-soft text-primary-strong sm:size-12"
        >
          <CloudUpload className="size-5 sm:size-6" />
        </span>
        <span className="mt-3 text-sm font-semibold text-foreground sm:mt-4 sm:text-[15px]">
          Drag &amp; drop your resume here
        </span>
        <span className="mt-1 text-xs text-subtle-foreground sm:text-[13px]">or</span>
        <span className="mt-2.5 inline-flex min-h-10 items-center rounded-md bg-primary px-4 text-xs font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2 sm:mt-3 sm:min-h-11 sm:px-5 sm:text-sm pointer-fine:min-h-10">
          Choose File
        </span>
        <span className="mt-2.5 text-[11px] text-subtle-foreground sm:mt-3 sm:text-xs">
          PDF only, up to 10 MB. The file is read once and never stored.
        </span>

        <input
          ref={inputRef}
          type="file"
          name="resume"
          accept="application/pdf,.pdf"
          disabled={uploading}
          onChange={(event) => accept(event.target.files?.[0])}
          className="sr-only"
        />
      </label>

      {file !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2 sm:mt-4 sm:gap-3 sm:px-3 sm:py-2.5">
          <FileText className="size-3.5 shrink-0 text-primary-strong sm:size-4" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground sm:text-sm">
            {file.name}
          </span>
          <span className="text-[11px] text-subtle-foreground tabular-nums sm:text-xs">
            {formatBytes(file.size)}
          </span>
          <button
            type="button"
            onClick={clearPick}
            disabled={uploading}
            aria-label={`Remove ${file.name}`}
            className="grid size-7 place-items-center rounded-sm text-subtle-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-60 sm:size-8"
          >
            <X className="size-3.5 sm:size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {error.length > 0 && (
        <p
          role="alert"
          className="mt-3 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-2.5 py-2 text-xs leading-relaxed text-destructive sm:mt-4 sm:px-3 sm:py-2.5 sm:text-sm"
        >
          <AlertCircle className="mt-0.5 size-3.5 shrink-0 sm:size-4" aria-hidden="true" />
          {error}
        </p>
      )}

      {done && error.length === 0 && (
        <div className="mt-3 rounded-md border border-accent/25 bg-accent/5 px-2.5 py-2 sm:mt-4 sm:px-3 sm:py-2.5">
          <p role="status" className="flex items-start gap-2 text-xs leading-relaxed text-accent-strong sm:text-sm">
            <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 sm:size-4" aria-hidden="true" />
            Resume parsed.
            {profile !== null && profile.manualFields.length > 0
              ? " Fields you had edited by hand were left as they were."
              : " Your skills and preferences are saved."}
          </p>
          <Link
            href="/recommended-jobs"
            className="mt-2 inline-flex min-h-9 items-center gap-2 rounded-md bg-primary px-3 text-xs font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2 sm:mt-2.5 sm:min-h-10 sm:px-4 sm:text-sm"
          >
            <Sparkles className="size-3.5 sm:size-4" aria-hidden="true" />
            View your matches
          </Link>
        </div>
      )}

      <button
        type="submit"
        disabled={uploading || file === null}
        className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-4 text-xs font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 sm:mt-5 sm:min-h-11 sm:w-auto sm:px-5 sm:text-sm pointer-fine:min-h-10"
      >
        {uploading ? (
          <Loader2 className="size-3.5 animate-spin sm:size-4" aria-hidden="true" />
        ) : (
          <CloudUpload className="size-3.5 sm:size-4" aria-hidden="true" />
        )}
        {uploading ? "Parsing…" : hasResume ? "Upload replacement" : "Upload resume"}
      </button>

      {uploading && (
        <p role="status" className="mt-2.5 text-xs text-subtle-foreground sm:mt-3 sm:text-sm">
          Reading your resume. This usually takes a few seconds.
        </p>
      )}
    </form>
  );
}

/**
 * "Your Resume" — what the API actually kept from the last upload.
 *
 * There is no "View Resume" link, unlike the reference: the PDF is parsed and
 * discarded, so nothing is stored to open. The fields read out of it are shown
 * instead, which is the part that exists and the part that decides matches.
 */
export function ResumeSummaryCard({ profile }: { profile: CandidateProfile }) {
  const parsedAt = formatDate(profile.resumeParsedAt);
  const shownSkills = profile.skills.slice(0, 8);
  const moreSkills = profile.skills.length - shownSkills.length;

  return (
    <section className="rounded-lg border border-border bg-surface p-4 shadow-e1 sm:p-5 lg:p-6">
      <h2 className="font-heading text-base font-semibold tracking-heading text-foreground sm:text-lg">
        Your Resume
      </h2>

      <div className="mt-3 flex flex-wrap items-center gap-2.5 rounded-md border border-border bg-background px-2.5 py-2.5 sm:mt-4 sm:gap-3 sm:px-3 sm:py-3">
        <span
          aria-hidden="true"
          className="grid size-9 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-strong sm:size-10"
        >
          <FileText className="size-4.5 sm:size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-foreground sm:text-sm">
            {profile.resumeFileName ?? "Resume"}
          </p>
          <p className="mt-0.5 text-[11px] text-subtle-foreground sm:text-[13px]">
            {parsedAt === null ? "Parsed" : `Parsed ${parsedAt}`}
          </p>
        </div>
      </div>

      {shownSkills.length > 0 ? (
        <>
          <p className="mt-4 text-[10px] font-semibold tracking-label text-subtle-foreground uppercase sm:mt-5 sm:text-[11px]">
            Skills read from it
          </p>
          <ul className="mt-2 flex flex-wrap gap-1.5 sm:mt-2.5 sm:gap-2">
            {shownSkills.map((skill) => (
              <li
                key={skill}
                className="inline-flex items-center rounded-sm border border-border bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground sm:px-2 sm:py-1 sm:text-[13px]"
              >
                {skill}
              </li>
            ))}
            {moreSkills > 0 && (
              <li className="inline-flex items-center rounded-sm px-1 py-0.5 text-[11px] text-subtle-foreground tabular-nums sm:py-1 sm:text-[13px]">
                +{moreSkills} more
              </li>
            )}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-subtle-foreground sm:mt-4 sm:text-sm">
          No skills were read from this file. Add them by hand in{" "}
          <Link href="/dashboard/profile" className="font-medium text-primary-strong underline">
            Profile Settings
          </Link>{" "}
          so your matches improve.
        </p>
      )}
    </section>
  );
}
