/**
 * Presentation helpers shared by every place a job is drawn — the homepage grid,
 * the /jobs list row, the detail page and the dashboard.
 *
 * Extracted so those four never disagree about what a posting is called, which
 * letter its monogram is, or how its date reads.
 */
import type { PublicJob } from "@/lib/api";
import type { OpportunityType } from "@/lib/opportunities";

/**
 * Opportunity type from the role text, matching the `/intern/i` rule the API uses
 * for its `internship` / `full-time` filter values. Keeping the same rule on both
 * sides is what makes the type chip agree with the filter that found the job.
 */
export function inferOpportunityType(role: string | null): OpportunityType {
  return role && /intern/i.test(role) ? "internship" : "full-time";
}

/**
 * Posted date, formatted identically on the server and in the browser.
 *
 * Pinned to UTC on purpose: a relative "2 days ago" or a locale-local date is
 * computed against whichever clock renders it, so the server HTML and the
 * hydrated output disagree and React replaces the node.
 */
export function formatPostedDate(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return "Recently";

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The company name, or a neutral stand-in when extraction found none. */
export function displayCompany(job: PublicJob): string {
  return job.company?.trim() || "Opportunity";
}

/** The role, or an explicit note that it is missing — never a guess. */
export function displayRole(job: PublicJob): string {
  return job.role?.trim() || "Role not specified";
}

/** First letter of whatever the card is titled. The fallback when no logo exists. */
export function jobMonogram(job: PublicJob): string {
  return (job.company?.trim() || job.role?.trim() || "J").charAt(0).toUpperCase();
}

/**
 * The company's logo URL, or null.
 *
 * Resolved server-side during ingestion and stored on the job, so there is no
 * lookup, guess or third-party request on this side — the client either has a
 * verified URL or draws the monogram. Only `https` is accepted: an `http` image
 * on an https page is blocked as mixed content, which would render as a broken
 * icon rather than as the fallback.
 */
export function jobLogoUrl(job: PublicJob): string | null {
  const url = job.companyLogoUrl?.trim();
  if (!url) return null;

  return url.startsWith("https://") ? url : null;
}

/**
 * The stored employment type, tidied for display, or null.
 *
 * Only some postings carry one — the value comes from the source text — so this
 * returns null rather than inventing "Full-time" for the rest. The type chip
 * every card shows is the derived one above; this is extra detail when it exists.
 */
export function displayEmploymentType(job: PublicJob): string | null {
  const value = job.employmentType?.trim();
  if (!value) return null;

  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The location, or null. Same rule: absent stays absent. */
export function displayLocation(job: PublicJob): string | null {
  return job.location?.trim() || null;
}
