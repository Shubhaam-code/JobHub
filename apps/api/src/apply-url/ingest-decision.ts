/**
 * Turning one posted URL into the apply fields a job is stored with.
 *
 * This is the ingest-time counterpart to `resolveApplyUrlFields` in the job
 * repository: the repository decides what to store given a *judgement*, and this
 * module does the work of reaching a judgement when that costs network calls.
 *
 * The order is deliberate, and it is the reason an aggregator URL can no longer
 * reach the apply field:
 *
 *   1. classify the posted URL, resolving it first if it is a shortener;
 *   2. if the answer is `aggregator`, **open the article and look for the real
 *      link inside it** — that is the only way to recover a usable destination;
 *   3. take the one candidate that is unambiguously the application, if there is
 *      one, and store *that*;
 *   4. otherwise store nothing in the apply field, keep the article as
 *      `sourceUrl`, and hand every candidate to a human.
 *
 * Step 4 is the difference from the resolver this replaces. The old design said
 * "resolution can improve a link but never lose one", so any failure fell back to
 * storing the aggregator URL. That fallback *was* the bug. Here a failure produces
 * an empty apply field and a review item, which is honest: we do not know where to
 * send the candidate, so we do not pretend to.
 *
 * Never throws. Every failure is a decision with a reason.
 */

import { logger } from '../lib/logger.js';
import { extractApplyCandidates, pickConfidentCandidate } from './candidates.js';
import { classifyApplyUrl } from './classify.js';
import { fetchPageHtml } from './fetch-page.js';
import { classifyAndResolveApplyUrl } from './index.js';
import { type ApplyUrlCandidate } from './status.js';

export interface IngestApplyUrlInput {
  /** The URL as extracted from the post. Untrusted. */
  postedUrl: string | null;
  company?: string | null;
  /** Prefix for log lines, e.g. `[@channel msg 123]`. */
  ref?: string;
}

export interface IngestApplyUrlDecision {
  /** The link to store, or null when there is nothing defensible to store. */
  applyUrl: string | null;
  /** The page the link came from, when it was an article rather than the form. */
  sourceUrl: string | null;
  /** Everything a reviewer needs, when the choice was not obvious. */
  candidates: ApplyUrlCandidate[] | null;
  /** One line explaining the outcome, for the log and the audit trail. */
  reason: string;
}

export interface IngestApplyUrlOptions {
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  /** Set false to skip opening aggregator pages (used by the audit script). */
  resolveAggregatorPages?: boolean;
}

/**
 * Decides the apply fields for one posted URL.
 *
 * The returned `applyUrl` is always either `direct` by the classifier's own
 * judgement or null — never "the best of a bad set".
 */
export async function decideIngestApplyUrl(
  input: IngestApplyUrlInput,
  options: IngestApplyUrlOptions = {},
): Promise<IngestApplyUrlDecision> {
  const { postedUrl, company } = input;
  const ref = input.ref ?? '';
  const resolvePages = options.resolveAggregatorPages ?? true;

  const first = await classifyAndResolveApplyUrl(postedUrl, {
    company,
    fetchImpl: options.fetchImpl,
  });

  // Already a destination: store it, with nothing to review.
  if (first.verdict === 'direct') {
    return {
      applyUrl: first.normalizedUrl,
      sourceUrl: null,
      candidates: null,
      reason: `direct: ${first.reason}`,
    };
  }

  // No URL at all, or a malformed one. Nothing to do and nothing to invent.
  if (first.verdict === 'unresolvable') {
    return { applyUrl: null, sourceUrl: null, candidates: null, reason: first.reason };
  }

  const pageUrl = first.normalizedUrl;

  // A `suspicious` verdict is not an article we know how to read, so it is not
  // opened — it goes to review with itself as the single candidate.
  if (first.verdict !== 'aggregator' || pageUrl === null || !resolvePages) {
    return {
      applyUrl: null,
      sourceUrl: first.verdict === 'aggregator' ? pageUrl : null,
      candidates:
        pageUrl === null
          ? null
          : [
              {
                url: pageUrl,
                finalUrl: first.finalUrl ?? null,
                confidence: 'low',
                score: 0,
                reason: first.reason,
                label: null,
              },
            ],
      reason: `${first.verdict}: ${first.reason}`,
    };
  }

  // ── An aggregator article. Open it and look for the real apply link. ──
  const page = await fetchPageHtml(pageUrl, { fetchImpl: options.fetchImpl });

  if (!page.ok) {
    // The article could not be read, so the destination is unknown. The article
    // is kept as provenance and a human takes it from here — the apply field
    // stays empty rather than falling back to the aggregator.
    return {
      applyUrl: null,
      sourceUrl: pageUrl,
      candidates: null,
      reason: `aggregator page unreadable (${page.reason})`,
    };
  }

  const candidates = extractApplyCandidates(page.html, pageUrl, { company });
  const winner = pickConfidentCandidate(candidates);

  if (winner === null) {
    if (candidates.length > 0 && ref.length > 0) {
      logger.debug(
        `${ref} ${String(candidates.length)} apply candidate(s) found, none conclusive → review`,
      );
    }
    return {
      applyUrl: null,
      sourceUrl: pageUrl,
      candidates: candidates.length > 0 ? candidates : null,
      reason:
        candidates.length === 0
          ? 'aggregator page had no apply candidate'
          : `${String(candidates.length)} candidates, none conclusive`,
    };
  }

  // The winner is re-classified on its own terms. Scoring a candidate highly is
  // not the same as it being storable, and only the classifier decides that.
  const verdict = classifyApplyUrl(winner.url, { company });

  if (verdict.verdict !== 'direct') {
    return {
      applyUrl: null,
      sourceUrl: pageUrl,
      candidates,
      reason: `best candidate is ${verdict.verdict} (${verdict.reason})`,
    };
  }

  return {
    applyUrl: verdict.normalizedUrl,
    // The article stays as provenance: it is where the link came from, and it is
    // what a reviewer opens if the link later turns out to be wrong.
    sourceUrl: pageUrl,
    candidates: candidates.length > 1 ? candidates : null,
    reason: `resolved from the aggregator page (${winner.reason})`,
  };
}
