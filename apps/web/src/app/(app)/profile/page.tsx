"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  CheckCircle2,
  FileText,
  FileUp,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";

import {
  fetchProfile,
  JOB_TYPE_OPTIONS,
  updateProfile,
  uploadResume,
  type CandidateProfile,
  type ProfileUpdate,
} from "@/lib/profile";

/**
 * Resume upload and preference editing — the input side of the recommendation
 * feature, and the only way to get a profile.
 *
 * The API mints the profile token on the first resume upload, so until a resume
 * has been parsed there is nothing to authenticate a preference edit against.
 * That is why the upload card is the whole page when there is no profile yet,
 * and the preference form only appears once one exists.
 */
type Status = "loading" | "empty" | "ready" | "error";

/**
 * The form's own shape: lists are edited as comma-separated text and the two
 * numeric fields as strings, because an input's value is a string and an
 * in-progress edit ("20" on the way to "2026") is not a valid value yet.
 */
interface PreferenceForm {
  skills: string;
  preferredRoles: string;
  preferredLocations: string;
  preferredJobTypes: string[];
  experienceYears: string;
  graduationYear: string;
}

const EMPTY_FORM: PreferenceForm = {
  skills: "",
  preferredRoles: "",
  preferredLocations: "",
  preferredJobTypes: [],
  experienceYears: "",
  graduationYear: "",
};

function toForm(profile: CandidateProfile): PreferenceForm {
  return {
    skills: profile.skills.join(", "),
    preferredRoles: profile.preferredRoles.join(", "),
    preferredLocations: profile.preferredLocations.join(", "),
    preferredJobTypes: [...profile.preferredJobTypes],
    experienceYears: profile.experienceYears === null ? "" : String(profile.experienceYears),
    graduationYear: profile.graduationYear ?? "",
  };
}

/** Commas or newlines separate entries; blanks are dropped, not sent. */
function parseList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Order-insensitive, for the job-type checkboxes. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * The fields that actually changed, and nothing else.
 *
 * Sending only the difference matters beyond saving bytes: the API records every
 * field in a request as manually edited, and a manually edited field is never
 * refreshed by a later resume upload. Sending all six on every save would freeze
 * the whole profile after the first click.
 */
function buildUpdate(form: PreferenceForm, profile: CandidateProfile): ProfileUpdate {
  const update: ProfileUpdate = {};

  const skills = parseList(form.skills);
  if (!sameList(skills, profile.skills)) update.skills = skills;

  const preferredRoles = parseList(form.preferredRoles);
  if (!sameList(preferredRoles, profile.preferredRoles)) update.preferredRoles = preferredRoles;

  const preferredLocations = parseList(form.preferredLocations);
  if (!sameList(preferredLocations, profile.preferredLocations)) {
    update.preferredLocations = preferredLocations;
  }

  if (!sameSet(form.preferredJobTypes, profile.preferredJobTypes)) {
    update.preferredJobTypes = [...form.preferredJobTypes];
  }

  const experienceText = form.experienceYears.trim();
  const experienceYears = experienceText === "" ? null : Number(experienceText);
  if (experienceYears !== profile.experienceYears) update.experienceYears = experienceYears;

  const graduationYear = form.graduationYear.trim() === "" ? null : form.graduationYear.trim();
  if (graduationYear !== profile.graduationYear) update.graduationYear = graduationYear;

  return update;
}

function formatParsedAt(value: string | null): string | null {
  if (value === null) return null;

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The API's own message when it sent one, a reachability hint when it did not. */
function errorText(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Unable to reach the API. Check that it is running and try again.";
}

const FIELD_CLASS =
  "min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors duration-150 outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 pointer-fine:min-h-10";

export default function ProfilePage() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("loading");
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [form, setForm] = useState<PreferenceForm>(EMPTY_FORM);
  const [loadError, setLoadError] = useState("");
  const [retryKey, setRetryKey] = useState(0);

  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [notice, setNotice] = useState("");

  /* Load the caller's profile on mount, and again on every retry. Written as a
     promise chain rather than an awaited helper so every state update lands in a
     callback: an update on the synchronous path out of an effect cascades an
     extra render. */
  useEffect(() => {
    let isSubscribed = true;
    const controller = new AbortController();

    fetchProfile(controller.signal)
      .then((result) => {
        if (!isSubscribed) return;

        // null covers both "no token stored" and "the stored token no longer
        // resolves" (`fetchProfile` drops a dead one): either way there is no
        // profile yet, so the upload card is the whole page.
        if (result === null) {
          setStatus("empty");
          return;
        }

        setProfile(result);
        setForm(toForm(result));
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || !isSubscribed) return;

        setLoadError(errorText(error));
        setStatus("error");
      });

    return () => {
      isSubscribed = false;
      controller.abort();
    };
  }, [retryKey]);
  const handleRetryLoad = () => {
    setStatus("loading");
    setLoadError("");
    setRetryKey((key) => key + 1);
  };

  const handleUpload = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (uploading || file === null) return;

    setUploading(true);
    setUploadError("");
    setSaveError("");
    setNotice("");

    try {
      const result = await uploadResume(file);

      setProfile(result);
      setForm(toForm(result));
      setStatus("ready");
      setFile(null);
      // The input keeps its own value; clearing it is what lets the same file be
      // picked again after a failure.
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
      setNotice(
        result.manualFields.length > 0
          ? "Resume parsed. Fields you had edited by hand were left as they were. Finding your matches…"
          : "Resume parsed. Finding your matches…",
      );

      /* The API stored the parsed skills and preferences as part of the upload,
         so the recommendations page can score against them on its next request.
         Scoring itself stays on the server — nothing here decides a match. */
      router.push("/recommended-jobs");
    } catch (error: unknown) {
      setUploadError(errorText(error));
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || profile === null) return;

    const experienceText = form.experienceYears.trim();
    const experience = experienceText === "" ? null : Number(experienceText);
    if (
      experience !== null &&
      (!Number.isFinite(experience) || experience < 0 || experience > 50)
    ) {
      setNotice("");
      setSaveError("Experience must be a number of years between 0 and 50.");
      return;
    }

    const update = buildUpdate(form, profile);
    if (Object.keys(update).length === 0) {
      setSaveError("");
      setNotice("Nothing to save — your preferences are already up to date.");
      return;
    }

    setSaving(true);
    setSaveError("");
    setNotice("");

    try {
      const result = await updateProfile(update);

      // Reseed from the response: the API canonicalizes skills ("nodejs" →
      // "Node.js") and de-duplicates lists, so what it stored is what should be
      // on screen — otherwise the next save would look dirty when it is not.
      setProfile(result);
      setForm(toForm(result));
      setNotice("Preferences saved. Your recommendations use them from now on.");
    } catch (error: unknown) {
      setSaveError(errorText(error));
    } finally {
      setSaving(false);
    }
  };

  const toggleJobType = (value: string) => {
    setForm((previous) => ({
      ...previous,
      preferredJobTypes: previous.preferredJobTypes.includes(value)
        ? previous.preferredJobTypes.filter((entry) => entry !== value)
        : [...previous.preferredJobTypes, value],
    }));
  };

  const dirty = profile !== null && Object.keys(buildUpdate(form, profile)).length > 0;
  const parsedAt = profile === null ? null : formatParsedAt(profile.resumeParsedAt);

  return (
    <main id="main">
      <section className="border-b border-border/70 bg-gradient-to-b from-surface to-background">
        <div className="mx-auto w-full max-w-3xl px-4 pt-14 pb-14 text-center sm:px-6 sm:pt-20 sm:pb-16 lg:px-8 lg:pt-24 lg:pb-20">
          <span className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-surface px-2.5 py-1 text-[11px] font-semibold tracking-label text-muted-foreground uppercase">
            <FileText className="size-3" aria-hidden="true" />
            Your profile
          </span>
          <h1 className="mt-4 font-heading text-3xl leading-tight font-semibold tracking-display text-balance text-foreground sm:text-4xl lg:text-5xl">
            Resume &amp; Preferences
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            Upload your resume once. We read your skills and preferences from it, then match every
            posting against them — and you can edit anything by hand.
          </p>
          {status === "ready" && (
            <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
              <Link
                href="/recommended-jobs"
                className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
              >
                <Sparkles className="size-4" aria-hidden="true" />
                View your recommendations
              </Link>
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto w-full max-w-3xl px-4 pt-10 pb-16 sm:px-6 sm:pb-20 lg:px-8 lg:pb-24">
        {status === "loading" ? (
          <>
            <span className="sr-only" role="status">
              Loading your profile
            </span>
            <div className="flex flex-col gap-6">
              <div className="h-44 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
              <div className="h-96 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
            </div>
          </>
        ) : status === "error" ? (
          <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center sm:py-12">
            <span
              aria-hidden="true"
              className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
            >
              <AlertCircle className="size-6" />
            </span>
            <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
              Unable to load your profile
            </h2>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
              {loadError}
            </p>
            <button
              type="button"
              onClick={handleRetryLoad}
              className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              Try again
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-6">
            {/* ── Resume ────────────────────────────────────────────────── */}
            <form
              onSubmit={handleUpload}
              className="rounded-lg border border-border bg-surface p-6 shadow-e1 sm:p-7"
            >
              <div className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="grid size-11 shrink-0 place-items-center rounded-md border border-border bg-muted text-muted-foreground"
                >
                  <FileUp className="size-5" />
                </span>
                <div>
                  <h2 className="font-heading text-lg font-semibold tracking-heading text-foreground">
                    {profile?.hasResume ? "Replace your resume" : "Upload your resume"}
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-subtle-foreground">
                    PDF only. The file is read once and discarded — only the fields below are
                    stored.
                  </p>
                </div>
              </div>

              {profile?.hasResume && (
                <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-background px-3 py-2.5 text-sm text-muted-foreground">
                  <FileText className="size-4 shrink-0 text-subtle-foreground" aria-hidden="true" />
                  <span className="font-medium text-foreground">
                    {profile.resumeFileName ?? "Resume"}
                  </span>
                  {parsedAt !== null && (
                    <span className="text-subtle-foreground">parsed {parsedAt}</span>
                  )}
                </p>
              )}

              <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  ref={fileInputRef}
                  id="resume-file"
                  type="file"
                  name="resume"
                  accept="application/pdf,.pdf"
                  disabled={uploading}
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setUploadError("");
                  }}
                  aria-label="Resume PDF"
                  className="w-full cursor-pointer rounded-md border border-border bg-background text-sm text-muted-foreground transition-colors duration-150 outline-none file:mr-3 file:min-h-11 file:cursor-pointer file:border-0 file:border-r file:border-border file:bg-muted file:px-4 file:text-sm file:font-medium file:text-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60 pointer-fine:file:min-h-10"
                />
                <button
                  type="submit"
                  disabled={uploading || file === null}
                  className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 pointer-fine:min-h-10"
                >
                  {uploading ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <FileUp className="size-4" aria-hidden="true" />
                  )}
                  {uploading ? "Parsing…" : profile?.hasResume ? "Re-upload" : "Upload & parse"}
                </button>
              </div>

              {uploading && (
                <p role="status" className="mt-3 text-sm text-subtle-foreground">
                  Reading your resume. This usually takes a few seconds.
                </p>
              )}

              {uploadError.length > 0 && (
                <p
                  role="alert"
                  className="mt-4 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
                >
                  <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  {uploadError}
                </p>
              )}
            </form>

            {/* ── Preferences ───────────────────────────────────────────── */}
            {status === "empty" ? (
              <p className="rounded-lg border border-dashed border-border-strong bg-surface px-6 py-8 text-center text-sm leading-relaxed text-subtle-foreground">
                Your skills and preferences appear here once a resume has been parsed. You can edit
                every one of them afterwards.
              </p>
            ) : (
              profile !== null && (
                <form
                  onSubmit={handleSave}
                  className="rounded-lg border border-border bg-surface p-6 shadow-e1 sm:p-7"
                >
                  <h2 className="font-heading text-lg font-semibold tracking-heading text-foreground">
                    Preferences
                  </h2>
                  <p className="mt-1 text-sm leading-relaxed text-subtle-foreground">
                    These are what jobs are scored against. Separate entries with commas.
                  </p>

                  <div className="mt-6 flex flex-col gap-5">
                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="skills" className="text-sm font-medium text-foreground">
                        Skills
                      </label>
                      <textarea
                        id="skills"
                        name="skills"
                        rows={3}
                        value={form.skills}
                        onChange={(event) =>
                          setForm((previous) => ({ ...previous, skills: event.target.value }))
                        }
                        placeholder="Java, Spring Boot, MongoDB"
                        className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm leading-relaxed text-foreground transition-colors duration-150 outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
                      />
                      <p className="text-xs text-subtle-foreground">
                        The biggest factor in a match score. Up to 30 entries.
                      </p>
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="roles" className="text-sm font-medium text-foreground">
                        Preferred roles
                      </label>
                      <input
                        id="roles"
                        name="preferredRoles"
                        type="text"
                        value={form.preferredRoles}
                        onChange={(event) =>
                          setForm((previous) => ({
                            ...previous,
                            preferredRoles: event.target.value,
                          }))
                        }
                        placeholder="Backend Developer, Data Analyst"
                        className={FIELD_CLASS}
                      />
                    </div>

                    <div className="flex flex-col gap-1.5">
                      <label htmlFor="locations" className="text-sm font-medium text-foreground">
                        Preferred locations
                      </label>
                      <input
                        id="locations"
                        name="preferredLocations"
                        type="text"
                        value={form.preferredLocations}
                        onChange={(event) =>
                          setForm((previous) => ({
                            ...previous,
                            preferredLocations: event.target.value,
                          }))
                        }
                        placeholder="Bengaluru, Remote"
                        className={FIELD_CLASS}
                      />
                    </div>

                    <fieldset className="flex flex-col gap-2.5">
                      <legend className="text-sm font-medium text-foreground">Job types</legend>
                      <div className="flex flex-wrap gap-2">
                        {JOB_TYPE_OPTIONS.map((option) => {
                          const checked = form.preferredJobTypes.includes(option.value);

                          return (
                            <label
                              key={option.value}
                              className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3.5 text-sm font-medium transition-[background-color,border-color,color] duration-150 pointer-fine:min-h-10 ${
                                checked
                                  ? "border-primary bg-primary/10 text-foreground"
                                  : "border-border bg-background text-muted-foreground hover:border-border-strong hover:bg-muted"
                              }`}
                            >
                              <input
                                type="checkbox"
                                name="preferredJobTypes"
                                value={option.value}
                                checked={checked}
                                onChange={() => toggleJobType(option.value)}
                                className="size-4 accent-primary"
                              />
                              {option.label}
                            </label>
                          );
                        })}
                      </div>
                    </fieldset>

                    <div className="grid gap-5 sm:grid-cols-2">
                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="experience" className="text-sm font-medium text-foreground">
                          Years of experience
                        </label>
                        <input
                          id="experience"
                          name="experienceYears"
                          type="number"
                          inputMode="decimal"
                          min={0}
                          max={50}
                          step={0.5}
                          value={form.experienceYears}
                          onChange={(event) =>
                            setForm((previous) => ({
                              ...previous,
                              experienceYears: event.target.value,
                            }))
                          }
                          placeholder="0"
                          className={FIELD_CLASS}
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label htmlFor="graduation" className="text-sm font-medium text-foreground">
                          Graduation year
                        </label>
                        <input
                          id="graduation"
                          name="graduationYear"
                          type="text"
                          inputMode="numeric"
                          maxLength={4}
                          value={form.graduationYear}
                          onChange={(event) =>
                            setForm((previous) => ({
                              ...previous,
                              graduationYear: event.target.value,
                            }))
                          }
                          placeholder="2026"
                          className={FIELD_CLASS}
                        />
                      </div>
                    </div>
                  </div>

                  {saveError.length > 0 && (
                    <p
                      role="alert"
                      className="mt-5 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
                    >
                      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      {saveError}
                    </p>
                  )}

                  {notice.length > 0 && saveError.length === 0 && (
                    <p
                      role="status"
                      className="mt-5 flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground"
                    >
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                      {notice}
                    </p>
                  )}

                  <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-5">
                    <button
                      type="submit"
                      disabled={saving || !dirty}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 pointer-fine:min-h-10"
                    >
                      {saving ? (
                        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Save className="size-4" aria-hidden="true" />
                      )}
                      {saving ? "Saving…" : "Save preferences"}
                    </button>
                    <Link
                      href="/recommended-jobs"
                      className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
                    >
                      <Sparkles className="size-4" aria-hidden="true" />
                      See recommendations
                    </Link>
                  </div>
                </form>
              )
            )}
          </div>
        )}
      </section>
    </main>
  );
}
