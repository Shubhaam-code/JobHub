/**
 * Shared types for the Universal Apply Discovery Agent.
 */

import { type ApplyUrlCandidate } from '../apply-url/status.js';

/**
 * Job context needed for apply URL discovery.
 */
export interface JobContext {
  jobId: string;
  company: string | null;
  role: string | null;
  location: string | null;
  employmentType: string | null;
  batch: string | null;
  sourceUrl: string | null;
  initialApplyUrl: string | null;
  initialCandidates?: ApplyUrlCandidate[] | null;
}

/**
 * Evidence collected during URL validation.
 * Each field is a specific check result.
 */
export interface ValidationEvidence {
  /** Does the page's company match the job's company? */
  companyMatch: boolean;
  /** Company match confidence (0-100). */
  companyMatchScore: number;
  /** Signals found that indicate company match. */
  companySignals: string[];

  /** Does the page's role match the job's role? */
  roleMatch: boolean;
  /** Role match confidence (0-100). */
  roleMatchScore: number;
  /** Signals found that indicate role match. */
  roleSignals: string[];

  /** Is the location compatible? */
  locationMatch: boolean;
  /** Location signals found. */
  locationSignals: string[];

  /** Does the page have actual application action? */
  hasApplicationAction: boolean;
  /** Application action signals found (buttons, forms, links). */
  applicationSignals: string[];

  /** Is this an official company or ATS source? */
  isOfficialSource: boolean;
  /** Type of official source: company_careers, trusted_ats, or null. */
  officialSourceType: 'company_careers' | 'trusted_ats' | null;

  /** Is the job still open/active? */
  isJobActive: boolean;
  /** Signals indicating job status. */
  statusSignals: string[];

  /** Overall verification confidence (0-100). */
  overallConfidence: number;

  /** Human-readable summary of verification. */
  summary: string;
}

/**
 * Result from URL validation.
 */
export interface ValidationResult {
  /** Whether the URL passes all verification checks. */
  verified: boolean;
  /** Detailed evidence supporting the decision. */
  evidence: ValidationEvidence;
  /** Human-readable reason for the decision. */
  reason: string;
}

/**
 * Discovery method used to find the apply URL.
 */
export type DiscoveryMethod =
  | 'direct_extraction'
  | 'firecrawl_scrape'
  | 'web_search'
  | 'company_search'
  | 'none';

/**
 * Cost tracking for external API usage.
 */
export interface CostTracking {
  usedFirecrawl: boolean;
  usedWebSearch: boolean;
  externalApiCalls: number;
}

/**
 * Final result from the universal discovery agent.
 */
export interface UniversalDiscoveryResult {
  /** Discovered and verified apply URL, or null if none found. */
  applyUrl: string | null;
  /** Whether the URL was successfully verified. */
  verified: boolean;
  /** Method used to discover the URL. */
  discoveryMethod: DiscoveryMethod;
  /** Evidence supporting verification. */
  verificationEvidence: ValidationEvidence | null;
  /** All candidates found during discovery. */
  candidates: ApplyUrlCandidate[];
  /** Cost tracking for monitoring. */
  costs: CostTracking;
  /** Human-readable reason for the outcome. */
  reason: string;
}

/**
 * Options for the universal discovery agent.
 */
export interface UniversalDiscoveryOptions {
  /** Whether to use Firecrawl when direct extraction fails. */
  enableFirecrawl?: boolean;
  /** Whether to use web search when Firecrawl fails. */
  enableWebSearch?: boolean;
  /** Maximum external API calls allowed (cost control). */
  maxExternalCalls?: number;
  /** Injected for testing. */
  fetchImpl?: typeof fetch;
}
