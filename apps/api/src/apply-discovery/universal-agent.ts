/**
 * Universal Apply Link Discovery Agent
 *
 * Source-agnostic discovery pipeline:
 *   1. Direct Extraction (from initial data)
 *   2. Firecrawl Deep Scrape (if direct fails, cost-controlled)
 *   3. Web Search Fallback (if Firecrawl fails, cost-controlled)
 *   4. Intelligent Validation (evidence-based, multi-signal)
 *   5. Verification Decision (strict: verified=true only with strong evidence)
 *
 * Key Principles:
 * - Evidence-based verification (not just confidence scores)
 * - Cost-controlled fallbacks (Firecrawl/Search only when needed)
 * - Source-agnostic (works for any job website)
 * - No guessing (null if evidence insufficient)
 */

import { logger } from '../lib/logger.js';
import { classifyApplyUrl, hostMatchesCompany, hostOfUrl, isTrustedAtsHost } from '../apply-url/classify.js';
import { type ApplyUrlCandidate } from '../apply-url/status.js';
import {
  type JobContext,
  type UniversalDiscoveryResult,
  type UniversalDiscoveryOptions,
  type ValidationEvidence,
  type CostTracking,
} from './types.js';

/**
 * Universal Apply Link Discovery Agent.
 *
 * Orchestrates the entire discovery pipeline:
 * - Tries direct extraction first (zero cost)
 * - Falls back to Firecrawl if enabled and needed
 * - Falls back to web search if enabled and needed
 * - Validates all candidates with evidence-based checks
 * - Returns verified URL only when evidence is strong
 */
export async function discoverApplyUrl(
  context: JobContext,
  options: UniversalDiscoveryOptions = {},
): Promise<UniversalDiscoveryResult> {
  const enableFirecrawl = options.enableFirecrawl ?? true;
  const enableWebSearch = options.enableWebSearch ?? true;
  const maxExternalCalls = options.maxExternalCalls ?? 5;

  const costs: CostTracking = {
    usedFirecrawl: false,
    usedWebSearch: false,
    externalApiCalls: 0,
  };

  const ref = `[jobId=${context.jobId} company=${context.company ?? '(none)'}]`;

  /* URLs already validated in an earlier stage. Stages overlap heavily — the link
     Firecrawl finds is often the one already extracted — and each validation is a
     real HTTP fetch, so re-validating the same URL costs time and adds nothing. */
  const tried = new Set<string>();

  logger.debug(`${ref} universal discovery started`);

  // ═══════════════════════════════════════════════════════════════════════
  // STAGE 1: Direct Extraction
  // ═══════════════════════════════════════════════════════════════════════
  // Use initial data: initialApplyUrl and initialCandidates from ingestion.
  // Zero cost, always attempted first.

  const allCandidates: ApplyUrlCandidate[] = [];

  // If we have an initial apply URL, classify it first.
  if (context.initialApplyUrl) {
    const classification = classifyApplyUrl(context.initialApplyUrl, {
      company: context.company,
    });

    logger.debug(
      `${ref} initial url verdict=${classification.verdict} reason=${classification.reason}`,
    );

    if (classification.verdict === 'direct' && classification.normalizedUrl) {
      // Initial URL is already a valid direct link. Validate it.
      tried.add(classification.normalizedUrl);
      const validation = await validateApplyUrl(
        classification.normalizedUrl,
        context,
        options.fetchImpl,
      );

      if (validation.verified) {
        logger.info(`${ref} verified via direct extraction (initial url)`);

        return {
          applyUrl: classification.normalizedUrl,
          verified: true,
          discoveryMethod: 'direct_extraction',
          verificationEvidence: validation.evidence,
          candidates: [
            {
              url: classification.normalizedUrl,
              finalUrl: null,
              confidence: 'highest',
              score: 10,
              reason: 'initial url from extraction',
              label: null,
            },
          ],
          costs,
          reason: `verified initial url: ${validation.reason}`,
        };
      }

      // Initial URL didn't pass validation, but keep it as a candidate.
      allCandidates.push({
        url: classification.normalizedUrl,
        finalUrl: null,
        confidence: 'low',
        score: 2,
        reason: `initial url failed validation: ${validation.reason}`,
        label: null,
      });
    }
  }

  // Add initial candidates from aggregator page extraction.
  if (context.initialCandidates && context.initialCandidates.length > 0) {
    logger.debug(`${ref} has ${String(context.initialCandidates.length)} initial candidates`);
    allCandidates.push(...context.initialCandidates);

    const found = await validateBest(context.initialCandidates, context, options.fetchImpl, tried);
    if (found !== null) {
      logger.info(`${ref} verified via direct extraction (initial candidate)`);

      return {
        applyUrl: found.candidate.url,
        verified: true,
        discoveryMethod: 'direct_extraction',
        verificationEvidence: found.validation.evidence,
        candidates: allCandidates,
        costs,
        reason: `verified initial candidate: ${found.validation.reason}`,
      };
    }
  }

  logger.debug(`${ref} direct extraction insufficient, candidates=${String(allCandidates.length)}`);

  // ═══════════════════════════════════════════════════════════════════════
  // STAGE 2: Firecrawl Deep Scrape (cost-controlled)
  // ═══════════════════════════════════════════════════════════════════════
  // Only used when:
  // - enabled
  // - direct extraction didn't find verified URL
  // - we have a sourceUrl to scrape
  // - we haven't hit cost limit

  if (
    enableFirecrawl &&
    context.sourceUrl &&
    costs.externalApiCalls < maxExternalCalls &&
    shouldUseFirecrawl(allCandidates)
  ) {
    logger.info(`${ref} attempting firecrawl scrape`);

    // Import dynamically to avoid dependency if Firecrawl not configured.
    const { scrapeWithFirecrawl } = await import('./firecrawl.js');

    const firecrawlResult = await scrapeWithFirecrawl(context.sourceUrl, {
      company: context.company,
      fetchImpl: options.fetchImpl,
    });

    costs.usedFirecrawl = true;
    costs.externalApiCalls += firecrawlResult.apiCallsMade;

    if (firecrawlResult.ok && firecrawlResult.candidates.length > 0) {
      logger.debug(`${ref} firecrawl found ${String(firecrawlResult.candidates.length)} candidates`);

      allCandidates.push(...firecrawlResult.candidates);

      const found = await validateBest(firecrawlResult.candidates, context, options.fetchImpl, tried);
      if (found !== null) {
        logger.info(`${ref} verified via firecrawl`);

        return {
          applyUrl: found.candidate.url,
          verified: true,
          discoveryMethod: 'firecrawl_scrape',
          verificationEvidence: found.validation.evidence,
          candidates: allCandidates,
          costs,
          reason: `verified firecrawl candidate: ${found.validation.reason}`,
        };
      }
    } else {
      logger.debug(`${ref} firecrawl failed: ${firecrawlResult.reason}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STAGE 3: Web Search Fallback (cost-controlled)
  // ═══════════════════════════════════════════════════════════════════════
  // Only used when:
  // - enabled
  // - Firecrawl didn't find verified URL
  // - we have enough job metadata for search
  // - we haven't hit cost limit

  if (
    enableWebSearch &&
    costs.externalApiCalls < maxExternalCalls &&
    shouldUseWebSearch(context)
  ) {
    logger.info(`${ref} attempting web search`);

    // Import dynamically.
    const { searchApplyUrl } = await import('./web-search.js');

    const searchResult = await searchApplyUrl(context, {
      fetchImpl: options.fetchImpl,
    });

    costs.usedWebSearch = true;
    costs.externalApiCalls += searchResult.apiCallsMade;

    if (searchResult.ok && searchResult.candidates.length > 0) {
      logger.debug(`${ref} web search found ${String(searchResult.candidates.length)} candidates`);

      allCandidates.push(...searchResult.candidates);

      const found = await validateBest(searchResult.candidates, context, options.fetchImpl, tried);
      if (found !== null) {
        logger.info(`${ref} verified via web search`);

        return {
          applyUrl: found.candidate.url,
          verified: true,
          discoveryMethod: 'web_search',
          verificationEvidence: found.validation.evidence,
          candidates: allCandidates,
          costs,
          reason: `verified web search candidate: ${found.validation.reason}`,
        };
      }
    } else {
      logger.debug(`${ref} web search failed: ${searchResult.reason}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STAGE 4: Official Company / ATS Site Discovery (cost-controlled)
  // ═══════════════════════════════════════════════════════════════════════
  // The earlier stages produce hosts without producing the posting: a search hit on
  // `careers.acme.com` that turns out to be the careers *index*, or an ATS host with
  // the wrong job id. This stage takes those hosts and asks what job URLs they
  // actually contain, which is the one thing a page fetch of an index cannot tell us.

  if (
    enableFirecrawl &&
    costs.externalApiCalls < maxExternalCalls &&
    allCandidates.length > 0
  ) {
    const site = pickOfficialSite(allCandidates, context, tried);

    if (site !== null) {
      logger.info(`${ref} attempting site map discovery on ${site}`);

      const { mapSiteForApplyUrls } = await import('./firecrawl.js');

      const mapResult = await mapSiteForApplyUrls(site, {
        company: context.company,
        role: context.role,
        fetchImpl: options.fetchImpl,
      });

      costs.usedFirecrawl = true;
      costs.externalApiCalls += mapResult.apiCallsMade;

      if (mapResult.ok && mapResult.candidates.length > 0) {
        allCandidates.push(...mapResult.candidates);

        const found = await validateBest(mapResult.candidates, context, options.fetchImpl, tried);
        if (found !== null) {
          logger.info(`${ref} verified via official site discovery`);

          return {
            applyUrl: found.candidate.url,
            verified: true,
            discoveryMethod: 'company_search',
            verificationEvidence: found.validation.evidence,
            candidates: allCandidates,
            costs,
            reason: `verified mapped candidate: ${found.validation.reason}`,
          };
        }
      } else {
        logger.debug(`${ref} site map found nothing: ${mapResult.reason}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STAGE 5: Final Decision
  // ═══════════════════════════════════════════════════════════════════════
  // No verified URL found. Return null with all candidates for review.

  logger.info(
    `${ref} no verified url found (candidates=${allCandidates.length}, firecrawl=${costs.usedFirecrawl}, search=${costs.usedWebSearch})`,
  );

  return {
    applyUrl: null,
    verified: false,
    discoveryMethod: 'none',
    verificationEvidence: null,
    candidates: allCandidates,
    costs,
    reason:
      allCandidates.length === 0
        ? 'no candidates found'
        : `${allCandidates.length} candidates found but none verified`,
  };
}

/**
 * How many candidates one stage may validate.
 *
 * Each validation is an HTTP fetch of a third-party page, so this is the knob that
 * keeps a page with sixty outbound links from becoming sixty requests. Four is
 * enough to get past a couple of near-misses at the top of the ranking; beyond that
 * the ranking is guessing and a human should look instead.
 */
const MAX_VALIDATIONS_PER_STAGE = 4;

/**
 * Validates candidates in ranked order and returns the first that verifies.
 *
 * This replaces validating only `pickConfidentCandidate`'s single winner. That
 * function is deliberately strict — it exists to decide when a link may be applied
 * *without* verification — and using it here meant a page offering three plausible
 * links validated none of them and fell through to "needs review". Verification is
 * a real fetch of the destination, so trying the top few in order is both cheap
 * enough and strictly more informative than a tie-break rule.
 *
 * `tried` is shared across stages so the same URL is never fetched twice.
 */
async function validateBest(
  candidates: readonly ApplyUrlCandidate[],
  context: JobContext,
  fetchImpl: typeof fetch | undefined,
  tried: Set<string>,
): Promise<{ candidate: ApplyUrlCandidate; validation: Awaited<ReturnType<typeof validateApplyUrl>> } | null> {
  // Highest score first; `reject` candidates exist only to be shown to a human.
  const ranked = [...candidates]
    .filter((candidate) => candidate.confidence !== 'reject')
    .sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));

  let attempts = 0;

  for (const candidate of ranked) {
    if (attempts >= MAX_VALIDATIONS_PER_STAGE) break;
    if (tried.has(candidate.url)) continue;

    tried.add(candidate.url);
    attempts += 1;

    const validation = await validateApplyUrl(candidate.url, context, fetchImpl);
    if (validation.verified) return { candidate, validation };
  }

  return null;
}

/**
 * The best official host to map, or null when nothing found so far is official.
 *
 * Only an employer host or a trusted ATS is worth mapping: mapping anything else
 * would spend a call inventorying a site that cannot hold this employer's
 * application. The origin is returned rather than the candidate URL, because the
 * point of this stage is to ask what *else* the site contains.
 */
function pickOfficialSite(
  candidates: readonly ApplyUrlCandidate[],
  context: JobContext,
  tried: ReadonlySet<string>,
): string | null {
  const seen = new Set<string>();

  for (const candidate of [...candidates].sort((a, b) => b.score - a.score)) {
    const host = hostOfUrl(candidate.url);
    if (host === null || seen.has(host)) continue;
    seen.add(host);

    if (!isTrustedAtsHost(host) && !hostMatchesCompany(host, context.company)) continue;

    /* A candidate already validated and rejected still identifies a good site to
       map — the host was right and the path was wrong, which is exactly the case
       this stage is for. So `tried` is not a filter here, only a tie-breaker:
       prefer a host whose pages have not been read yet. */
    if (tried.has(candidate.url) && candidates.length > 1) {
      const alternative = candidates.find((other) => {
        const otherHost = hostOfUrl(other.url);
        return otherHost !== null && otherHost !== host && !tried.has(other.url);
      });
      if (alternative !== undefined) continue;
    }

    try {
      return new URL(candidate.url).origin;
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Decides whether Firecrawl should be used.
 *
 * Use Firecrawl when:
 * - We have few or no candidates from direct extraction
 * - OR initial candidates were low confidence
 */
function shouldUseFirecrawl(existingCandidates: ApplyUrlCandidate[]): boolean {
  // No candidates yet - definitely try Firecrawl.
  if (existingCandidates.length === 0) return true;

  /* Anything that reached this point failed validation, so "we already have a
     high-confidence candidate" is not a reason to stop — that candidate has been
     tried and rejected. What matters is whether the page has been read at all:
     a rendered scrape sees apply buttons that the ingest-time HTML did not. */
  const hasUntriedStrongCandidate = existingCandidates.some(
    (candidate) =>
      (candidate.confidence === 'high' || candidate.confidence === 'highest') &&
      candidate.score >= 6,
  );

  // Several strong leads already: a scrape is unlikely to add a better one.
  if (existingCandidates.length >= 3 && hasUntriedStrongCandidate) return false;

  return true;
}

/**
 * Decides whether web search should be used.
 *
 * Use web search when:
 * - We have sufficient job metadata (company + role at minimum)
 */
function shouldUseWebSearch(context: JobContext): boolean {
  // Need at least company and role for meaningful search.
  return Boolean(context.company && context.role);
}

/**
 * Validates a candidate URL with evidence-based checks.
 *
 * This is imported from the validator module (to be implemented next).
 * For now, this is a placeholder that will be replaced.
 */
async function validateApplyUrl(
  url: string,
  context: JobContext,
  fetchImpl?: typeof fetch,
): Promise<{ verified: boolean; evidence: ValidationEvidence; reason: string }> {
  // Import the real validator (will be implemented in next task).
  const { validateApplyUrlWithEvidence } = await import('./validator.js');
  return validateApplyUrlWithEvidence(url, context, { fetchImpl });
}
