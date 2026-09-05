"use client";

import { useId } from "react";
import { CalendarDays, RotateCcw } from "lucide-react";

import {
  DATE_POSTED_FILTERS,
  todayInput,
  windowStartInput,
  type DatePostedId,
  type GlobalInternshipFilterState,
} from "@/lib/global-internship-filters";

/**
 * Date controls for the Global Internships feed.
 *
 * A horizontal chip row rather than the Jobs page's sidebar: this feed has one
 * filter group, so a whole column beside the grid would be mostly empty. The
 * chips are a native radio group, which is what gives them arrow-key navigation
 * and "one of these" semantics for free.
 *
 * Every change commits immediately — there is no Apply button, because with a
 * single group there is nothing to batch up.
 */
export function GlobalInternshipFilterBar({
  filters,
  onChange,
  onReset,
}: {
  filters: GlobalInternshipFilterState;
  onChange: (next: GlobalInternshipFilterState) => void;
  onReset: () => void;
}) {
  const groupName = useId();
  const minDate = windowStartInput();
  const maxDate = todayInput();

  /* Leaving "Pick a date" clears the dates, so a stale one cannot reappear the
     next time it is chosen. */
  const selectDate = (id: DatePostedId) =>
    onChange({
      ...filters,
      datePosted: id,
      ...(id === "custom" ? {} : { customFrom: "", customTo: "" }),
    });

  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-e1">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <fieldset className="min-w-0">
          <legend className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
            Date posted
          </legend>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {DATE_POSTED_FILTERS.map((option) => {
              const checked = filters.datePosted === option.id;
              return (
                <label
                  key={option.id}
                  className={`inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors duration-150 pointer-fine:min-h-8 ${
                    checked
                      ? "border-primary/40 bg-primary-soft font-semibold text-primary-strong"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <input
                    type="radio"
                    name={groupName}
                    value={option.id}
                    checked={checked}
                    onChange={() => selectDate(option.id)}
                    className="sr-only"
                  />
                  {option.id === "custom" && (
                    <CalendarDays className="size-3.5 shrink-0" aria-hidden="true" />
                  )}
                  {option.label}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
            Sort
            <select
              value={filters.sort}
              onChange={(event) =>
                onChange({
                  ...filters,
                  sort: event.target.value === "oldest" ? "oldest" : "newest",
                })
              }
              className="min-h-9 rounded-md border border-border bg-surface px-2 text-[13px] font-medium text-foreground normal-case"
            >
              <option value="newest">Newest</option>
              <option value="oldest">Oldest</option>
            </select>
          </label>

          <button
            type="button"
            onClick={onReset}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground"
          >
            <RotateCcw className="size-3.5" aria-hidden="true" />
            Reset
          </button>
        </div>
      </div>

      {/* One date is one day; adding a second makes it a range. Both are bounded
          to the feed's own 21-day window, so the calendar cannot offer a day that
          returns nothing. */}
      {filters.datePosted === "custom" && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-md bg-muted/60 p-2.5">
          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
            Date
            <input
              type="date"
              value={filters.customFrom}
              min={minDate}
              max={filters.customTo || maxDate}
              onChange={(event) => onChange({ ...filters, customFrom: event.target.value })}
              className="min-h-9 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground"
            />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-medium text-muted-foreground">
            To <span className="font-normal normal-case">(optional)</span>
            <input
              type="date"
              value={filters.customTo}
              min={filters.customFrom || minDate}
              max={maxDate}
              onChange={(event) => onChange({ ...filters, customTo: event.target.value })}
              className="min-h-9 rounded-md border border-border bg-surface px-2 text-[13px] text-foreground"
            />
          </label>
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-subtle-foreground">
            Pick one date for a single day, or add a second for a range. The feed covers the last 21
            days.
          </p>
        </div>
      )}
    </div>
  );
}
