/**
 * Firecrawl Integration for Deep Apply URL Discovery
 *
 * Uses Firecrawl API to:
 * - Scrape JS-rendered pages
 * - Crawl nested application pages
 * - Extract structured apply link data
 *
 * Cost-controlled: only used when direct extraction fails.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { extractApplyCandidates } from '../apply-url/candidates.js';
import {
  classifyApplyUrl,
  hostMatchesCompany,
  hostOfUrl,
  isTrustedAtsHost,
} from '../apply-url/classify.js';
import { type ApplyUrlCandidate } from '../apply-url/status.js';

export interface FirecrawlOptions {
  company?: string | null;
  fetchImpl?: typeof fetch;
}

export interface FirecrawlResult {
  ok: boolean;
  candidates: ApplyUrlCandidate[];
  apiCallsMade: number;
  reason: string;
}

const FIRECRAWL_TIMEOUT_MS = 15000;

/**
 * Firecrawl's `links` format has been both a plain `string[]` and a list of
 * `{ url, text }` objects across versions. Both are accepted so an API change
 * degrades to "no fallback links" instead of a crash.
 */
function normalizeLinks(links: Array<string | { url?: string; text?: string }> | undefined): string[] {
  if (!Array.isArray(links)) return [];

  const out: string[] = [];
  for (const entry of links) {
    const href = typeof entry === 'string' ? entry : entry?.url;
    if (typeof href === 'string' && href.length > 0) out.push(href);
  }
  return out;
}

/**
 * Adds URLs that only the flattened `links` list saw.
 *
 * These carry no anchor text, so they are scored on the URL alone and capped at
 * `medium` — enough to reach the validator, never enough to be auto-applied by
 * `pickConfidentCandidate`. A URL the HTML extractor already ranked is left
 * untouched, since its anchor-aware score is strictly better information.
 */
function mergeLinkFallbacks(
  candidates: ApplyUrlCandidate[],
  links: readonly string[],
  pageUrl: string,
  company: string | null | undefined,
): ApplyUrlCandidate[] {
  if (links.length === 0) return candidates;

  const pageHost = hostOfUrl(pageUrl);
  const seen = new Set(candidates.map((candidate) => candidate.url));
  const extra: ApplyUrlCandidate[] = [];

  for (const href of links) {
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }

    const classification = classifyApplyUrl(absolute, { company });
    const normalized = classification.normalizedUrl;
    if (normalized === null || seen.has(normalized)) continue;
    // Only a `direct` verdict is worth validating; an aggregator or a shortener
    // found with no anchor text is noise.
    if (classification.verdict !== 'direct') continue;

    const host = hostOfUrl(normalized);
    if (host === null || host === pageHost) continue;

    const isAts = isTrustedAtsHost(host);
    const matchesCompany = hostMatchesCompany(host, company);
    // A `direct` verdict on a host unrelated to both the employer and any known
    // ATS is not a lead — it is every other outbound link on the page.
    if (!isAts && !matchesCompany) continue;

    seen.add(normalized);
    extra.push({
      url: normalized,
      finalUrl: null,
      confidence: 'medium',
      score: isAts && matchesCompany ? 4 : 3,
      reason: `${classification.reason} (found in rendered page links)`,
      label: null,
    });
  }

  return [...candidates, ...extra].sort(
    (a, b) => b.score - a.score || a.url.localeCompare(b.url),
  );
}

/**
 * Scrapes a page using Firecrawl to discover apply URLs.
 *
 * Firecrawl renders JS and can crawl linked pages, making it effective for:
 * - Dynamic content that requires JS execution
 * - Apply buttons loaded after page render
 * - Nested application pages (e.g., company site → careers → specific job)
 */
export async function scrapeWithFirecrawl(
  url: string,
  options: FirecrawlOptions = {},
): Promise<FirecrawlResult> {
  const apiKey = env.FIRECRAWL_API_KEY;

  if (!apiKey || apiKey.trim().length === 0) {
    return {
      ok: false,
      candidates: [],
      apiCallsMade: 0,
      reason: 'Firecrawl API key not configured',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);

  try {
    logger.debug(`[firecrawl] scraping ${url}`);

    /* `html` is what the candidate extractor parses; `links` is Firecrawl's own
       flattened list of every href on the rendered page, which catches an apply
       anchor injected by script after load.

       `onlyMainContent` is deliberately false. It trims nav, header and footer —
       and an "Apply Now" button very often lives in exactly one of those. Trimming
       is the right default for reading an article and the wrong one for finding a
       link. */
    const response = await fetchImpl('https://api.firecrawl.dev/v2/scrape', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url,
        formats: ['html', 'links'],
        onlyMainContent: false,
        waitFor: 2000, // Let script-injected apply buttons land.
        timeout: FIRECRAWL_TIMEOUT_MS - 2000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      return {
        ok: false,
        candidates: [],
        apiCallsMade: 1,
        reason: `Firecrawl API error ${response.status}: ${errorText}`,
      };
    }

    const data = (await response.json()) as {
      success?: boolean;
      data?: {
        html?: string;
        links?: Array<string | { url?: string; text?: string }>;
        metadata?: {
          title?: string;
          description?: string;
        };
      };
    };

    const html = data.data?.html;
    const links = normalizeLinks(data.data?.links);

    if (html === undefined && links.length === 0) {
      return {
        ok: false,
        candidates: [],
        apiCallsMade: 1,
        reason: 'Firecrawl returned no HTML content',
      };
    }

    // Extract candidates from the Firecrawl HTML using existing logic.
    const candidates =
      html === undefined ? [] : extractApplyCandidates(html, url, { company: options.company });

    /* The `links` list has no anchor text, so it cannot be scored the way an
       anchor in the HTML can. It is merged as a fallback — a URL the extractor
       never saw is worth offering to the validator, and one it already found keeps
       its richer score. */
    const merged = mergeLinkFallbacks(candidates, links, url, options.company);

    logger.debug(
      `[firecrawl] extracted ${String(merged.length)} candidates from ${url} ` +
        `(html=${String(candidates.length)}, links=${String(merged.length - candidates.length)})`,
    );

    return {
      ok: true,
      candidates: merged,
      apiCallsMade: 1,
      reason: `found ${String(merged.length)} candidates`,
    };
  } catch (error: unknown) {
    clearTimeout(timer);

    const reason =
      controller.signal.aborted
        ? 'Firecrawl request timed out'
        : error instanceof Error
          ? error.message
          : String(error);

    logger.warn(`[firecrawl] failed for ${url}: ${reason}`);

    return {
      ok: false,
      candidates: [],
      apiCallsMade: 1,
      reason,
    };
  }
}

/**
 * Lists a site's own URLs and keeps the ones that look like an application.
 *
 * This is the "official company / ATS discovery" step. Given a host we already
 * believe belongs to the employer — its careers subdomain, or the domain a search
 * result pointed at — it asks Firecrawl for that site's URL inventory and ranks the
 * job-shaped entries.
 *
 * Map, not crawl, on purpose. Crawling is asynchronous (submit a job, poll an id)
 * and priced per page; mapping is one synchronous call that returns the site's URLs
 * with their titles, which is all this stage needs to nominate a candidate. The
 * candidate is still validated afterwards like any other, so a mapped URL is a lead
 * and never an answer.
 *
 * The `search` term is derived from the role, so a large careers site returns the
 * relevant slice of its inventory rather than its first few hundred URLs.
 */
export async function mapSiteForApplyUrls(
  siteUrl: string,
  options: FirecrawlOptions & { role?: string | null; limit?: number } = {},
): Promise<FirecrawlResult> {
  const apiKey = env.FIRECRAWL_API_KEY;

  if (!apiKey || apiKey.trim().length === 0) {
    return {
      ok: false,
      candidates: [],
      apiCallsMade: 0,
      reason: 'Firecrawl API key not configured',
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? MAP_URL_LIMIT;
  const search = mapSearchTerm(options.role);

  try {
    logger.debug(`[firecrawl] mapping ${siteUrl}${search === null ? '' : ` search="${search}"`}`);

    const response = await fetchImpl('https://api.firecrawl.dev/v2/map', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        url: siteUrl,
        limit,
        ...(search === null ? {} : { search }),
      }),
      signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => 'unknown error');
      return {
        ok: false,
        candidates: [],
        apiCallsMade: 1,
        reason: `Firecrawl map API error ${String(response.status)}: ${detail}`,
      };
    }

    const data = (await response.json()) as {
      success?: boolean;
      links?: Array<{ url?: string; title?: string; description?: string }>;
    };

    const links = Array.isArray(data.links) ? data.links : [];

    if (links.length === 0) {
      return {
        ok: false,
        candidates: [],
        apiCallsMade: 1,
        reason: 'Firecrawl map returned no URLs',
      };
    }

    const candidates = rankMappedLinks(links, options.company, options.role);

    logger.debug(
      `[firecrawl] mapped ${String(links.length)} urls from ${siteUrl}, ` +
        `${String(candidates.length)} candidates`,
    );

    return {
      ok: candidates.length > 0,
      candidates,
      apiCallsMade: 1,
      reason: `found ${String(candidates.length)} candidates from ${String(links.length)} mapped urls`,
    };
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.warn(`[firecrawl] map failed for ${siteUrl}: ${reason}`);

    return {
      ok: false,
      candidates: [],
      apiCallsMade: 1,
      reason,
    };
  }
}

/**
 * The role, reduced to the words worth searching a careers site for.
 *
 * Boilerplate like "off campus drive 2026" describes the posting, not the job, and
 * matches nothing on the employer's own site. Returning null asks for the site's
 * default inventory instead of filtering it down to zero.
 */
function mapSearchTerm(role: string | null | undefined): string | null {
  if (!role) return null;

  const words = role
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((word) => word.length >= 3 && !MAP_SEARCH_STOPWORDS.has(word));

  if (words.length === 0) return null;

  // Four words is plenty to identify a posting and short enough not to over-filter.
  return words.slice(0, 4).join(' ');
}

/** Posting-boilerplate words that never appear in an employer's own job title. */
const MAP_SEARCH_STOPWORDS = new Set([
  'off',
  'campus',
  'drive',
  'hiring',
  'recruitment',
  'batch',
  'freshers',
  'fresher',
  'apply',
  'now',
  'online',
  'jobs',
  'job',
  'opening',
  'openings',
  'vacancy',
  'notification',
  'salary',
  'eligibility',
  'for',
  'and',
  'the',
  '2024',
  '2025',
  '2026',
  '2027',
]);

/** How many URLs to ask a map call for. */
const MAP_URL_LIMIT = 50;

/** A mapped URL whose path names a posting or an application. */
const MAPPED_APPLY_PATH_REGEX =
  /\/(?:careers?|jobs?|job-?de\w+|apply|application|openings?|vacanc\w*|positions?|recruit\w*|candidate)(?:[/\-_.?=]|$)/i;

/**
 * Scores mapped URLs, best first.
 *
 * A mapped URL has a title but no anchor text and no surrounding page, so it is
 * scored on the two things that are actually knowable: whether the host is the
 * employer's or a trusted ATS, and whether the path and title name this posting.
 * Capped below `high` unless both the host and the role agree, so a mapped lead
 * cannot be auto-applied on host reputation alone.
 */
function rankMappedLinks(
  links: ReadonlyArray<{ url?: string; title?: string; description?: string }>,
  company: string | null | undefined,
  role: string | null | undefined,
): ApplyUrlCandidate[] {
  const roleTokens = (role ?? '')
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((word) => word.length >= 4 && !MAP_SEARCH_STOPWORDS.has(word));

  const found = new Map<string, ApplyUrlCandidate>();

  for (const link of links) {
    if (typeof link.url !== 'string' || link.url.length === 0) continue;

    const classification = classifyApplyUrl(link.url, { company });
    const normalized = classification.normalizedUrl;
    if (normalized === null || classification.verdict !== 'direct') continue;

    const host = hostOfUrl(normalized);
    if (host === null) continue;

    const pathname = new URL(normalized).pathname;
    const title = (link.title ?? '').trim();
    const haystack = `${pathname} ${title}`.toLowerCase();

    const reasons: string[] = [];
    let score = 0;

    if (isTrustedAtsHost(host)) {
      score += 3;
      reasons.push('trusted ATS domain');
    }
    if (hostMatchesCompany(host, company)) {
      score += 3;
      reasons.push('host matches the company');
    }
    if (MAPPED_APPLY_PATH_REGEX.test(pathname)) {
      score += 2;
      reasons.push('path names a posting or application');
    }

    // Neither the employer's site nor an ATS: a mapped URL from somewhere else is
    // not a lead worth a validation fetch.
    if (score === 0) continue;

    const roleHit = roleTokens.filter((token) => haystack.includes(token));
    if (roleHit.length > 0) {
      score += Math.min(roleHit.length, 2);
      reasons.push(`title or path mentions "${roleHit.slice(0, 2).join('", "')}"`);
    }

    /* `high` is reserved for a URL that names *this* posting on a host we trust —
       that is the only combination where the mapped lead is as good as an extracted
       anchor. Everything else is a `medium` lead for the validator. */
    const confidence: ApplyUrlCandidate['confidence'] =
      score >= 5 && roleHit.length > 0 ? 'high' : 'medium';

    const candidate: ApplyUrlCandidate = {
      url: normalized,
      finalUrl: null,
      confidence,
      score,
      reason: `${reasons.join('; ')} (site map)`,
      label: title.length > 0 ? title.slice(0, 120) : null,
    };

    const existing = found.get(normalized);
    if (existing === undefined || candidate.score > existing.score) {
      found.set(normalized, candidate);
    }
  }

  return [...found.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}
