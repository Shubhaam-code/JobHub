/**
 * Web Search Fallback for Apply URL Discovery
 *
 * Dynamically generates search queries based on job metadata and searches
 * for official company careers/application pages.
 *
 * Cost-controlled: only used when direct extraction and Firecrawl both fail.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { classifyApplyUrl, hostMatchesCompany, isTrustedAtsHost, hostOfUrl } from '../apply-url/classify.js';
import { type ApplyUrlCandidate } from '../apply-url/status.js';
import { type JobContext } from './types.js';

export interface WebSearchOptions {
  fetchImpl?: typeof fetch;
}

export interface WebSearchResult {
  ok: boolean;
  candidates: ApplyUrlCandidate[];
  apiCallsMade: number;
  reason: string;
}

/** Budget for a single provider call. */
export const SEARCH_TIMEOUT_MS = 10000;

/**
 * How many results to ask the provider for.
 *
 * Ten is enough that the official careers page is present when it exists at all,
 * and small enough that ranking stays cheap. Everything below the top few tiers is
 * discarded by `filterAndRankResults` anyway.
 */
const SEARCH_RESULT_LIMIT = 10;

/**
 * Priority tiers for search result ranking.
 */
const PRIORITY_TIERS = {
  OFFICIAL_COMPANY: 100,
  TRUSTED_ATS: 80,
  COMPANY_MATCH: 60,
  CAREERS_PATH: 40,
  OTHER: 20,
};

/**
 * Searches for the job's apply URL using web search.
 *
 * Strategy:
 * 1. Build targeted query from job metadata
 * 2. Search using web search API
 * 3. Filter and rank results by official sources
 * 4. Return top candidates
 */
export async function searchApplyUrl(
  context: JobContext,
  options: WebSearchOptions = {},
): Promise<WebSearchResult> {
  // Build search query dynamically from job metadata.
  const query = buildSearchQuery(context);

  if (!query) {
    return {
      ok: false,
      candidates: [],
      apiCallsMade: 0,
      reason: 'insufficient job metadata for search',
    };
  }

  logger.debug(`[web-search] query="${query}"`);

  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const results = await performSearch(query, fetchImpl);

    // `null` means no provider is wired in yet, which is different from a
    // provider that ran and found nothing.
    if (results === null) {
      logger.warn('[web-search] search API not configured - returning empty results');

      return {
        ok: false,
        candidates: [],
        apiCallsMade: 0,
        reason: 'search API not configured',
      };
    }

    const candidates = filterAndRankResults(results, context);

    return {
      ok: candidates.length > 0,
      candidates,
      apiCallsMade: 1,
      reason: `found ${candidates.length} candidates`,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`[web-search] search failed: ${reason}`);

    return {
      ok: false,
      candidates: [],
      apiCallsMade: 1,
      reason,
    };
  }
}

/**
 * Builds a targeted search query from job metadata.
 *
 * Query structure:
 *   "{company}" "{role}" {location} {batch} careers apply official
 *
 * Examples:
 *   "Virtusa" "Software Engineer Intern" Bangalore 2026 careers apply official
 *   "Google" "SDE Intern" India careers apply
 */
function buildSearchQuery(context: JobContext): string | null {
  const parts: string[] = [];

  // Company is essential for meaningful search.
  if (!context.company) return null;
  parts.push(`"${context.company}"`);

  // Role helps narrow down to specific position.
  if (context.role) {
    parts.push(`"${context.role}"`);
  }

  // Location helps find regional careers pages.
  if (context.location) {
    parts.push(context.location);
  }

  // Batch/year helps find current openings.
  if (context.batch) {
    parts.push(context.batch);
  }

  // Add search terms for careers pages.
  parts.push('careers apply official');

  return parts.join(' ');
}

/**
 * Filters and ranks search results by source quality.
 *
 * Priority order:
 * 1. Official company careers page
 * 2. Trusted ATS platform
 * 3. Company domain match
 * 4. Careers path signal
 * 5. Other results (low priority)
 */
function filterAndRankResults(
  searchResults: Array<{ url: string; title: string; snippet: string }>,
  context: JobContext,
): ApplyUrlCandidate[] {
  const candidates: ApplyUrlCandidate[] = [];

  for (const result of searchResults) {
    const classification = classifyApplyUrl(result.url, { company: context.company });

    // Skip non-direct results (aggregators, wrappers, etc.)
    if (classification.verdict !== 'direct' || !classification.normalizedUrl) {
      continue;
    }

    const host = hostOfUrl(classification.normalizedUrl);
    if (!host) continue;

    // Determine priority tier.
    let priority = PRIORITY_TIERS.OTHER;
    let reason = 'search result';

    if (isTrustedAtsHost(host)) {
      priority = PRIORITY_TIERS.TRUSTED_ATS;
      reason = 'trusted ATS from search';
    } else if (hostMatchesCompany(host, context.company)) {
      priority = PRIORITY_TIERS.OFFICIAL_COMPANY;
      reason = 'official company page from search';
    } else if (/\/careers?|\/jobs?|\/apply/i.test(classification.normalizedUrl)) {
      priority = PRIORITY_TIERS.CAREERS_PATH;
      reason = 'careers path from search';
    }

    candidates.push({
      url: classification.normalizedUrl,
      finalUrl: null,
      confidence: priority >= PRIORITY_TIERS.TRUSTED_ATS ? 'high' : 'medium',
      score: priority / 10,
      reason,
      label: result.title || null,
    });
  }

  // Sort by priority descending.
  candidates.sort((a, b) => b.score - a.score);

  return candidates;
}

/**
 * Calls the configured search provider.
 *
 * Returns `null` when no provider is configured, so the caller can report
 * "not configured" rather than "no results" — the two mean different things for
 * cost accounting and for deciding whether discovery actually tried.
 *
 * The provider is Firecrawl's search endpoint, reusing `FIRECRAWL_API_KEY`. It is
 * deliberately the same credential as the scrape stage: one key to configure, one
 * bill to watch, and a caller that already treats "no key" as "skip this stage".
 *
 * Only `web` results are read. Firecrawl can also return `news` and `images`
 * buckets; neither is an application page, and asking for them would spend
 * credits on results this pipeline would discard.
 */
async function performSearch(
  query: string,
  fetchImpl: typeof fetch,
): Promise<Array<{ url: string; title: string; snippet: string }> | null> {
  const apiKey = env.FIRECRAWL_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) return null;

  const response = await fetchImpl('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      sources: ['web'],
      limit: SEARCH_RESULT_LIMIT,
    }),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => 'unknown error');
    throw new Error(`Firecrawl search error ${String(response.status)}: ${detail}`);
  }

  const payload = (await response.json()) as {
    success?: boolean;
    data?: {
      web?: Array<{ url?: string; title?: string; description?: string }>;
    };
  };

  const web = payload.data?.web;
  if (!Array.isArray(web)) return [];

  /* A result without a URL is not a candidate, and the other two fields are only
     ever used as a label, so an absent title is an empty string rather than a
     dropped result. */
  return web
    .filter((item): item is { url: string; title?: string; description?: string } =>
      typeof item.url === 'string' && item.url.length > 0,
    )
    .map((item) => ({
      url: item.url,
      title: item.title ?? '',
      snippet: item.description ?? '',
    }));
}
