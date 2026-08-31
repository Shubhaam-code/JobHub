import type { PublicJob } from "./api";

export type OpportunityType = "internship" | "full-time";

export type Opportunity = PublicJob;

export const OPPORTUNITY_TYPE_LABELS: Record<OpportunityType, string> = {
  internship: "Internship",
  "full-time": "Full-time",
};

/**
 * Starting points offered under the search field and in the empty state.
 */
export const SEARCH_SUGGESTIONS = ["Bengaluru", "Remote", "2027", "Engineer"] as const;
