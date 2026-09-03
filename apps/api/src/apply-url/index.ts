/**
 * The apply-URL module's public surface.
 *
 * Import from here rather than from the individual files, so a caller picks up the
 * same judgement everything else uses. `classifyAndResolveApplyUrl` is the one to
 * reach for when a network call is acceptable; `classifyApplyUrl` is the pure,
 * synchronous form used on the write path and at render time.
 */

export {
  classifyApplyUrl,
  hostInList,
  hostMatches,
  hostMatchesCompany,
  hostOfUrl,
  isAggregatorHost,
  isFormHost,
  isOwnHost,
  isTrustedAtsHost,
  isWrapperHost,
  normalizeApplyUrl,
  type ApplyUrlClassification,
  type ApplyUrlVerdict,
  type ClassifyOptions,
} from './classify.js';

export {
  resolveApplyUrl,
  type ApplyUrlResolveResult,
  type ResolveOptions,
} from './resolve.js';

export {
  AGGREGATOR_DOMAINS,
  FORM_ONLY_HOSTS,
  FORM_PATH_HOSTS,
  JOB_BOARD_DOMAINS,
  OWN_DOMAINS,
  TRUSTED_ATS_DOMAINS,
  WRAPPER_DOMAINS,
} from './domains.js';

export {
  APPLY_URL_STATUSES,
  type ApplyUrlCandidate,
  type ApplyUrlStatus,
} from './status.js';

export {
  extractApplyCandidates,
  pickConfidentCandidate,
  type ExtractOptions,
} from './candidates.js';

export { fetchPageHtml, type FetchPageResult } from './fetch-page.js';

import { classifyApplyUrl, type ApplyUrlClassification, type ClassifyOptions } from './classify.js';
import { resolveApplyUrl, type ResolveOptions } from './resolve.js';

/**
 * Classifies a URL, following redirects first when the URL alone cannot be judged.
 *
 * The only case that costs a request is a `wrapper` verdict — a shortener or a
 * redirector, where the destination is genuinely unknown. Every other verdict is
 * returned from the pure classifier without touching the network, so the common
 * path (a company link, an ATS link, a known aggregator) is unchanged and free.
 *
 * A wrapper that cannot be resolved comes back as `suspicious`, never as `direct`:
 * an unresolved shortener is exactly the state this whole feature exists to keep
 * out of the apply field.
 */
export async function classifyAndResolveApplyUrl(
  raw: string | null | undefined,
  options: ClassifyOptions & ResolveOptions = {},
): Promise<ApplyUrlClassification> {
  const first = classifyApplyUrl(raw, options);
  if (first.verdict !== 'wrapper') return first;

  const resolved = await resolveApplyUrl(first.normalizedUrl, options);

  if (!resolved.ok) {
    return {
      ...first,
      verdict: 'suspicious',
      reason: `unresolved redirect wrapper (${resolved.reason ?? 'no final URL'})`,
      finalUrl: resolved.finalUrl,
      hops: resolved.hops,
    };
  }

  const final = classifyApplyUrl(resolved.finalUrl, options);

  // A wrapper that still lands on a wrapper host has not been resolved to
  // anything usable, so it is reported as needing a look rather than as direct.
  const stillWrapped = final.verdict === 'wrapper';

  return {
    ...final,
    verdict: stillWrapped ? 'suspicious' : final.verdict,
    reason: `${first.normalizedUrl ?? ''} → ${
      stillWrapped ? `resolves to another wrapper (${final.reason})` : final.reason
    }`,
    finalUrl: resolved.finalUrl,
    hops: resolved.hops,
  };
}
