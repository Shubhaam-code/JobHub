"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MapPin, Search } from "lucide-react";

/**
 * Keyword + location search, used by the homepage hero, the Jobs page header and
 * the landing page's search card.
 *
 * Both fields are real queries: keyword goes to the API's `search` (company or
 * role) and location to its `location`, so neither box is a decorative input.
 *
 * With no `onSearch`, submitting navigates to `/jobs` with the values in the URL
 * — which is what the homepage hero and the landing card do. The Jobs page passes
 * `onSearch` so it can filter in place instead of re-entering its own route.
 *
 * Three shapes, same behaviour:
 *   hero      one horizontal shell, fields side by side (homepage)
 *   compact   bare fields for a page that supplies its own container (/jobs)
 *   stacked   fields on their own rows over hairlines, full-width button — the
 *             narrow column card in the reference design (/welcome)
 */
export function JobSearchForm({
  defaultSearch = "",
  defaultLocation = "",
  variant = "compact",
  onSearch,
}: {
  defaultSearch?: string;
  defaultLocation?: string;
  variant?: "hero" | "compact" | "stacked";
  onSearch?: (search: string, location: string) => void;
}) {
  const [search, setSearch] = useState(defaultSearch);
  const [location, setLocation] = useState(defaultLocation);
  const router = useRouter();

  const hero = variant === "hero";
  const stacked = variant === "stacked";

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const keyword = search.trim();
    const place = location.trim();

    if (onSearch) {
      onSearch(keyword, place);
      return;
    }

    const params = new URLSearchParams();
    if (keyword) params.set("q", keyword);
    if (place) params.set("location", place);

    const query = params.toString();
    router.push(query ? `/jobs?${query}` : "/jobs");
  };

  const fieldClass = stacked
    ? /* A hairline under each field instead of a box around it, so the two read as
         one list inside the card rather than two nested controls. A step taller at
         desktop, which is the row height the reference card uses. */
      "min-h-11 w-full border-0 border-b border-border bg-transparent pr-3 pl-9 text-[15px] text-foreground placeholder:text-subtle-foreground focus:border-primary focus:outline-none lg:min-h-11"
    : "min-h-11 w-full rounded-md border border-border bg-surface pr-3 pl-10 text-[15px] text-foreground placeholder:text-subtle-foreground focus:border-primary focus:outline-none lg:min-h-10";

  const iconClass = `pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-subtle-foreground ${
    stacked ? "left-1" : "left-3"
  }`;

  return (
    <form
      onSubmit={handleSubmit}
      role="search"
      className={
        hero
          ? "flex flex-col gap-2 rounded-xl border border-border bg-surface p-2.5 shadow-e3 sm:flex-row sm:items-center"
          : stacked
            ? "flex flex-col gap-3"
            : "flex flex-col gap-2 sm:flex-row sm:items-center"
      }
    >
      <div className="relative flex-1">
        <label htmlFor="job-search-keyword" className="sr-only">
          Job title, role or company
        </label>
        <Search aria-hidden="true" className={iconClass} />
        <input
          id="job-search-keyword"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={stacked ? "Job title" : "Job title, role or company"}
          className={hero ? `${fieldClass} border-transparent` : fieldClass}
        />
      </div>

      {/* A hairline between the two fields inside the hero shell, so it reads as
          one control rather than two inputs sharing a box. */}
      {hero && <span aria-hidden="true" className="hidden h-8 w-px bg-border sm:block" />}

      <div className="relative flex-1">
        <label htmlFor="job-search-location" className="sr-only">
          Location
        </label>
        <MapPin aria-hidden="true" className={iconClass} />
        <input
          id="job-search-location"
          type="search"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="Location"
          className={hero ? `${fieldClass} border-transparent` : fieldClass}
        />
      </div>

      <button
        type="submit"
        className={
          stacked
            ? "mt-2.5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-primary px-5 text-[15px] font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] lg:min-h-10"
            : "inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] lg:min-h-10"
        }
      >
        {!stacked && <Search className="size-4" aria-hidden="true" />}
        {stacked ? "Search" : "Search Jobs"}
      </button>
    </form>
  );
}
