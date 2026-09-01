"use client";

import { useId, useState } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";

import {
  DATE_POSTED_FILTERS,
  JOB_TYPE_FILTERS,
  activeFilterCount,
  type DatePostedId,
  type JobFilterState,
  type JobTypeId,
} from "@/lib/job-filters";

/**
 * The Jobs page filter sidebar.
 *
 * Two groups, and only two: Date Posted and Job Type. Both are native radio
 * groups, so arrow-key navigation, the accessible group name and the "one of
 * these" semantics are the platform's rather than something re-implemented with
 * divs.
 *
 * Nothing is selected to begin with — that is the unfiltered feed, and it is what
 * Reset returns to. There is deliberately no "Anytime" / "All types" row: these
 * groups hold exactly the options they were specified with.
 *
 * The panel edits a draft and commits on submit, because the reference gives it
 * an explicit "Apply Filters" button. It takes its starting values from `initial`
 * once, on mount — the Jobs page remounts it (via `key`) whenever the committed
 * filters change, so a back-button navigation reloads the form without this
 * component having to synchronise state from an effect.
 */
export function JobFiltersPanel({
  initial,
  onApply,
  onReset,
}: {
  initial: JobFilterState;
  onApply: (next: JobFilterState) => void;
  onReset: () => void;
}) {
  const [draft, setDraft] = useState<JobFilterState>(initial);
  const dateGroupId = useId();
  const typeGroupId = useId();

  const selectedCount = activeFilterCount(draft);

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onApply(draft);
  };

  /* Leaving "Custom Date" clears the two dates, so a stale range cannot come
     back the next time it is picked. */
  const setDatePosted = (id: DatePostedId) =>
    setDraft((current) => ({
      ...current,
      datePosted: id,
      ...(id === "custom" ? {} : { customFrom: "", customTo: "" }),
    }));

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-border bg-surface p-4 shadow-e1"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="inline-flex items-center gap-2 font-heading text-sm font-semibold tracking-snug text-foreground">
          <SlidersHorizontal className="size-4 text-primary-strong" aria-hidden="true" />
          Filters
        </h2>
        {selectedCount > 0 && (
          <span className="inline-flex items-center rounded-sm bg-primary-soft px-1.5 py-0.5 text-[11px] font-semibold text-primary-strong tabular-nums">
            {selectedCount} selected
          </span>
        )}
      </div>

      <fieldset className="mt-3.5 border-t border-border pt-3">
        <legend className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
          Date Posted
        </legend>
        {/* Rows are deliberately tighter on a fine pointer than on touch: both
            groups have to fit one screen beside the list, and a mouse does not
            need the 40px target a thumb does. */}
        <div className="mt-2 flex flex-col gap-0.5">
          {DATE_POSTED_FILTERS.map((option) => {
            const checked = draft.datePosted === option.id;
            return (
              <label
                key={option.id}
                className={`flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150 pointer-fine:min-h-8 ${
                  checked
                    ? "bg-primary-soft font-semibold text-primary-strong"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <input
                  type="radio"
                  name={dateGroupId}
                  value={option.id}
                  checked={checked}
                  onChange={() => setDatePosted(option.id)}
                  className="size-3.5 shrink-0"
                />
                {option.label}
              </label>
            );
          })}
        </div>

        {/* Two bounds rather than one field: "Custom Date" is the escape hatch
            from the four presets, and a single fixed day is rarely the question
            anyone has. Either end may be left empty — "from the 1st onwards" and
            "up to the 10th" are both valid, and both are real API queries. */}
        {draft.datePosted === "custom" && (
          <div className="mt-2 grid grid-cols-2 gap-2 rounded-md bg-muted/60 p-2.5">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              From
              <input
                type="date"
                value={draft.customFrom}
                max={draft.customTo || undefined}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, customFrom: event.target.value }))
                }
                className="min-h-9 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
              To
              <input
                type="date"
                value={draft.customTo}
                min={draft.customFrom || undefined}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, customTo: event.target.value }))
                }
                className="min-h-9 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground"
              />
            </label>
          </div>
        )}
      </fieldset>

      <fieldset className="mt-3.5 border-t border-border pt-3">
        <legend className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
          Job Type
        </legend>
        <div className="mt-2 flex flex-col gap-0.5">
          {JOB_TYPE_FILTERS.map((option) => {
            const checked = draft.jobType === option.id;
            return (
              <label
                key={option.id}
                className={`flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-150 pointer-fine:min-h-8 ${
                  checked
                    ? "bg-primary-soft font-semibold text-primary-strong"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <input
                  type="radio"
                  name={typeGroupId}
                  value={option.id}
                  checked={checked}
                  onChange={() =>
                    setDraft((current) => ({ ...current, jobType: option.id as JobTypeId }))
                  }
                  className="size-3.5 shrink-0"
                />
                {option.label}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-3.5 flex flex-col gap-2 border-t border-border pt-3">
        <button
          type="submit"
          className="inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-9"
        >
          Apply Filters
        </button>
        {/* Clears the two groups above. The keyword and location boxes have their
            own clear controls, so this does not reach across and empty them. */}
        <button
          type="button"
          onClick={onReset}
          className="inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-9"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Reset
        </button>
      </div>
    </form>
  );
}
