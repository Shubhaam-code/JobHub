import type { PublicJob } from "./api";

export type OpportunityType = "internship" | "full-time";

export type Opportunity = PublicJob;

export const OPPORTUNITY_TYPE_LABELS: Record<OpportunityType, string> = {
  internship: "Internship",
  "full-time": "Full-time",
};
