"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertCircle, CheckCircle2, Loader2, Save, Sparkles } from "lucide-react";

import {
  errorText,
  JOB_TYPE_OPTIONS,
  updateProfile,
  type CandidateProfile,
  type ProfileUpdate,
} from "@/lib/profile";

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

const FIELD_CLASS =
  "min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors duration-150 outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 pointer-fine:min-h-10";

/**
 * Preference editing — the fields a job is scored against.
 *
 * Seeded from `profile` once, on mount: the dashboard remounts this (via `key`)
 * when a different profile arrives, so an in-progress edit is never overwritten
 * by a background refresh.
 */
export function ProfilePreferencesForm({
  profile,
  onSaved,
}: {
  profile: CandidateProfile;
  onSaved: (next: CandidateProfile) => void;
}) {
  const [form, setForm] = useState<PreferenceForm>(() => toForm(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    const experienceText = form.experienceYears.trim();
    const experience = experienceText === "" ? null : Number(experienceText);
    if (experience !== null && (!Number.isFinite(experience) || experience < 0 || experience > 50)) {
      setNotice("");
      setError("Experience must be a number of years between 0 and 50.");
      return;
    }

    const update = buildUpdate(form, profile);
    if (Object.keys(update).length === 0) {
      setError("");
      setNotice("Nothing to save — your preferences are already up to date.");
      return;
    }

    setSaving(true);
    setError("");
    setNotice("");

    try {
      const result = await updateProfile(update);

      // Reseed from the response: the API canonicalizes skills ("nodejs" →
      // "Node.js") and de-duplicates lists, so what it stored is what should be
      // on screen — otherwise the next save would look dirty when it is not.
      setForm(toForm(result));
      onSaved(result);
      setNotice("Preferences saved. Your recommendations use them from now on.");
    } catch (caught: unknown) {
      setError(errorText(caught));
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

  const dirty = Object.keys(buildUpdate(form, profile)).length > 0;

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-surface p-5 shadow-e1 sm:p-6"
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
            onChange={(event) => setForm((previous) => ({ ...previous, skills: event.target.value }))}
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
              setForm((previous) => ({ ...previous, preferredRoles: event.target.value }))
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
              setForm((previous) => ({ ...previous, preferredLocations: event.target.value }))
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
                setForm((previous) => ({ ...previous, experienceYears: event.target.value }))
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
                setForm((previous) => ({ ...previous, graduationYear: event.target.value }))
              }
              placeholder="2026"
              className={FIELD_CLASS}
            />
          </div>
        </div>
      </div>

      {error.length > 0 && (
        <p
          role="alert"
          className="mt-5 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {error}
        </p>
      )}

      {notice.length > 0 && error.length === 0 && (
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
  );
}
