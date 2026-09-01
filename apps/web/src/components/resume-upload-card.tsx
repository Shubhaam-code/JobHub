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
      className="rounded-lg border border-border bg-surface p-5 shadow-e1 sm:p-6"
    >
      <h2 className="font-heading text-lg font-semibold tracking-heading text-foreground">
        {hasResume ? "Replace Your Resume" : "Upload Your Resume"}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-subtle-foreground">
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
        className={`mt-5 flex cursor-pointer flex-col items-center rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors duration-150 ${
          dragging
            ? "border-primary bg-primary-soft"
            : "border-border-strong bg-background hover:border-primary/60 hover:bg-primary-soft/40"
        }`}
      >
        <span
          aria-hidden="true"
          className="grid size-12 place-items-center rounded-full bg-primary-soft text-primary-strong"
        >
          <CloudUpload className="size-6" />
        </span>
        <span className="mt-4 text-[15px] font-semibold text-foreground">
          Drag &amp; drop your resume here
        </span>
        <span className="mt-1 text-[13px] text-subtle-foreground">or</span>
        <span className="mt-3 inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2 pointer-fine:min-h-10">
          Choose File
        </span>
        <span className="mt-3 text-xs text-subtle-foreground">
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
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-2.5">
          <FileText className="size-4 shrink-0 text-primary-strong" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {file.name}
          </span>
          <span className="text-xs text-subtle-foreground tabular-nums">
            {formatBytes(file.size)}
          </span>
          <button
            type="button"
            onClick={clearPick}
            disabled={uploading}
            aria-label={`Remove ${file.name}`}
            className="grid size-8 place-items-center rounded-sm text-subtle-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:opacity-60"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {error.length > 0 && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {done && error.length === 0 && (
        <div className="mt-4 rounded-md border border-accent/25 bg-accent/5 px-3 py-2.5">
          <p role="status" className="flex items-start gap-2 text-sm leading-relaxed text-accent-strong">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            Resume parsed.
            {profile !== null && profile.manualFields.length > 0
              ? " Fields you had edited by hand were left as they were."
              : " Your skills and preferences are saved."}
          </p>
          <Link
            href="/recommended-jobs"
            className="mt-2.5 inline-flex min-h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2"
          >
            <Sparkles className="size-4" aria-hidden="true" />
            View your matches
          </Link>
        </div>
      )}

      <button
        type="submit"
        disabled={uploading || file === null}
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 pointer-fine:min-h-10 sm:w-auto"
      >
        {uploading ? (
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        ) : (
          <CloudUpload className="size-4" aria-hidden="true" />
        )}
        {uploading ? "Parsing…" : hasResume ? "Upload replacement" : "Upload resume"}
      </button>

      {uploading && (
        <p role="status" className="mt-3 text-sm text-subtle-foreground">
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
    <section className="rounded-lg border border-border bg-surface p-5 shadow-e1 sm:p-6">
      <h2 className="font-heading text-lg font-semibold tracking-heading text-foreground">
        Your Resume
      </h2>

      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-background px-3 py-3">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-md bg-primary-soft text-primary-strong"
        >
          <FileText className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {profile.resumeFileName ?? "Resume"}
          </p>
          <p className="mt-0.5 text-[13px] text-subtle-foreground">
            {parsedAt === null ? "Parsed" : `Parsed ${parsedAt}`}
          </p>
        </div>
      </div>

      {shownSkills.length > 0 ? (
        <>
          <p className="mt-5 text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
            Skills read from it
          </p>
          <ul className="mt-2.5 flex flex-wrap gap-2">
            {shownSkills.map((skill) => (
              <li
                key={skill}
                className="inline-flex items-center rounded-sm border border-border bg-muted px-2 py-1 text-[13px] font-medium text-muted-foreground"
              >
                {skill}
              </li>
            ))}
            {moreSkills > 0 && (
              <li className="inline-flex items-center rounded-sm px-1 py-1 text-[13px] text-subtle-foreground tabular-nums">
                +{moreSkills} more
              </li>
            )}
          </ul>
        </>
      ) : (
        <p className="mt-4 text-sm leading-relaxed text-subtle-foreground">
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
