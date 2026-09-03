/**
 * The one place a URL is judged to be an apply link or not.
 *
 * Everything that touches an apply URL — the ingest validator, the queue worker,
 * the backfill, the audit script, the admin review queue and the render guard —
 * calls into this module. There is deliberately no second copy of the rules, so
 * "what counts as a direct link" cannot drift between the write path and the read
 * path.
 *
 * Three functions, in the order they are normally used:
 *
 *   normalizeApplyUrl(raw)   →  a canonical, comparable URL string
 *   resolveApplyUrl(url)     →  the final URL after following redirects
 *   classifyApplyUrl(url)    →  { verdict, reason, … }
 *
 * ## Why matching is done on the parsed hostname
 *
 * Every domain test below runs against `new URL(...).hostname` — the WHATWG
 * parser's own answer — and compares it as `host === entry || host.endsWith('.' +
 * entry)`. That single choice closes the whole family of list-bypass tricks:
 *
 *  - `http://` vs `https://`      scheme is not part of the hostname
 *  - `WWW.FRESHERSHUNT.IN`        the parser lowercases; `www.` is stripped
 *  - `freshershunt.in.`           a trailing dot is stripped before matching
 *  - `x.y.freshershunt.in`        matched by the subdomain suffix rule
 *  - `careers.acme.com@bad.in`    everything before `@` is userinfo, not a host;
 *                                 the parser reports `bad.in`, and normalization
 *                                 drops the userinfo so nothing downstream can
 *                                 re-read it as a host
 *  - `freshershunt.in/../x`       path tricks cannot change the host at all
 *  - punycode / IDN homoglyphs    an `xn--` label never equals an ASCII entry, so
 *                                 it can never *pass* as trusted; it is reported
 *                                 as suspicious instead of quietly accepted
 *
 * A substring or regex test on the raw string would fail most of those, which is
 * why there is none here.
 */

import {
  AGGREGATOR_DOMAINS,
  ARTICLE_SLUG_REGEX,
  FORM_ONLY_HOSTS,
  FORM_PATH_HOSTS,
  JOB_BOARD_DOMAINS,
  OWN_DOMAINS,
  SUSPICIOUS_HOST_FRAGMENTS,
  TRUSTED_ATS_DOMAINS,
  WRAPPER_DOMAINS,
} from './domains.js';

/**
 * `direct`       — an employer, ATS or official form URL. Safe to store and render.
 * `aggregator`   — a competitor's article, or a link back to us. Never storable.
 * `wrapper`      — a shortener/redirector; resolve it, then classify the result.
 * `suspicious`   — heuristics fired. Storable only via human review.
 * `unresolvable` — not a usable http(s) URL at all.
 */
export type ApplyUrlVerdict =
  | 'direct'
  | 'aggregator'
  | 'wrapper'
  | 'suspicious'
  | 'unresolvable';

export interface ApplyUrlClassification {
  verdict: ApplyUrlVerdict;
  /** Short, human-readable justification. Shown in the admin queue and reports. */
  reason: string;
  /** Canonical form of the input, or null when it could not be parsed. */
  normalizedUrl: string | null;
  /** Final URL after redirects, when a resolve was performed. */
  finalUrl?: string;
  /** Redirect chain, when a resolve was performed. */
  hops?: string[];
}

export interface ClassifyOptions {
  /** The posting's company, used to judge whether an employer host plausibly matches. */
  company?: string | null;
}

/**
 * Zero-width and bidi formatting codepoints. A post forwarded through Telegram
 * carries these next to a link, and `\s` does not cover them — left in, they end
 * up percent-encoded inside the path and the href points at nothing.
 */
const INVISIBLE_CHAR_REGEX =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFC]/g;

/** Tracking parameters that identify a campaign, never a job. */
const TRACKING_PARAM_REGEX = /^(?:utm_[a-z_]*|fbclid|gclid|msclkid|igshid|mc_[a-z]+|ref|ref_src|source|src|campaign)$/i;

/** Query parameters that carry the real destination inside a wrapper link. */
const REDIRECT_PARAMS = [
  'url',
  'u',
  'target',
  'redirect',
  'redirect_to',
  'redirecturl',
  'dest',
  'destination',
  'link',
  'goto',
  'out',
  'q',
];

/**
 * Host labels that name a careers destination — `careers.acme.com`,
 * `jobs.acme.com`, `apply.acme.com`.
 */
const CAREER_HOST_LABELS = new Set([
  'career',
  'careers',
  'job',
  'jobs',
  'apply',
  'applications',
  'recruit',
  'recruiting',
  'recruitment',
  'hiring',
  'talent',
]);

/** A path that names a posting or an application form. */
const APPLY_PATH_REGEX =
  /\/(?:careers?|jobs?|job-?de\w+|apply|application|openings?|vacanc\w*|positions?|recruit\w*|forms?|viewform|hcmui|candidate|search)(?:[/\-_.?=]|$)/i;

/** Official-body suffixes where the site's own page genuinely is the apply route. */
const OFFICIAL_TLD_REGEX = /(?:^|\.)(?:gov|gov\.in|nic\.in|mil|ac\.in|edu|edu\.in|ac\.uk|res\.in)$/i;

/** Company-name tokens too generic to prove a host belongs to the employer. */
const GENERIC_COMPANY_TOKENS = new Set([
  'the',
  'inc',
  'ltd',
  'llc',
  'llp',
  'plc',
  'pvt',
  'private',
  'limited',
  'corp',
  'corporation',
  'company',
  'group',
  'global',
  'india',
  'technologies',
  'technology',
  'solutions',
  'services',
  'systems',
  'software',
  'labs',
  'consulting',
  'international',
]);

/** Hostname as the URL parser sees it: lowercased, no `www.`, no trailing dot. */
export function hostOfUrl(urlString: string): string | null {
  try {
    return new URL(urlString).hostname
      .toLowerCase()
      .replace(/\.+$/, '')
      .replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** True when `host` is exactly `entry` or a subdomain of it. */
export function hostMatches(host: string, entry: string): boolean {
  return host === entry || host.endsWith(`.${entry}`);
}

/** True when `host` is on `list` by exact match or as a subdomain. */
export function hostInList(host: string, list: readonly string[]): boolean {
  return list.some((entry) => hostMatches(host, entry));
}

export const isAggregatorHost = (host: string): boolean => hostInList(host, AGGREGATOR_DOMAINS);
export const isTrustedAtsHost = (host: string): boolean => hostInList(host, TRUSTED_ATS_DOMAINS);
export const isWrapperHost = (host: string): boolean => hostInList(host, WRAPPER_DOMAINS);
export const isOwnHost = (host: string): boolean => hostInList(host, OWN_DOMAINS);
export const isJobBoardHost = (host: string): boolean => hostInList(host, JOB_BOARD_DOMAINS);
export const isFormHost = (host: string): boolean =>
  hostInList(host, FORM_ONLY_HOSTS) || hostInList(host, FORM_PATH_HOSTS);

/**
 * Canonical form of a raw apply URL, or null when it is not a usable http(s) URL.
 *
 * Purely textual — no network. What it does, and why each step matters:
 *
 *  - adds `https://` to a scheme-less value, so `careers.acme.com/x` parses at all
 *  - rejects any scheme other than http(s), which is what keeps `javascript:` and
 *    `data:` out of an href
 *  - **drops userinfo**: `https://careers.acme.com@bad.in/x` normalizes to
 *    `https://bad.in/x`, so the deceptive prefix cannot survive into storage, a
 *    log line, or an admin's eye
 *  - lowercases the host and strips `www.` and a trailing dot, so one site has one
 *    canonical spelling and the domain lists cannot be dodged by spelling
 *  - unwraps a `?url=`-style redirector to its target (one level; `resolveApplyUrl`
 *    handles real HTTP redirect chains)
 *  - removes tracking parameters and the fragment, keeping every other parameter,
 *    because an ATS job id often lives in the query string
 *  - upgrades `http` to `https`, and drops a lone trailing slash
 */
export function normalizeApplyUrl(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  // Strip zero-width and bidi marks: a forwarded Telegram post glues these to a
  // link, and they otherwise end up percent-encoded inside the path.
  const cleaned = trimmed.replace(INVISIBLE_CHAR_REGEX, '');

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(cleaned) ? cleaned : `https://${cleaned}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // A wrapper carrying its destination in the query string: read the target and
  // normalize that instead. Bounded to one textual level on purpose.
  for (const param of REDIRECT_PARAMS) {
    const value = url.searchParams.get(param)?.trim();
    if (value === undefined || value.length === 0) continue;
    if (!/^https?:\/\//i.test(value)) continue;

    const inner = normalizeApplyUrl(value);
    if (inner !== null) return inner;
  }

  // Deceptive `user:pass@host` prefixes do not survive normalization.
  url.username = '';
  url.password = '';

  url.protocol = 'https:';
  url.hostname = url.hostname.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
  url.hash = '';

  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM_REGEX.test(key)) url.searchParams.delete(key);
  }

  let result = url.toString();
  // A bare host keeps its slash (`https://acme.com/`); a path loses its trailing one.
  if (url.pathname !== '/' && url.search === '' && result.endsWith('/')) {
    result = result.slice(0, -1);
  }

  return result;
}

/** True when some label of the host names a careers destination. */
function hasCareerHost(host: string): boolean {
  return host.split('.').some((label) => CAREER_HOST_LABELS.has(label));
}

/** Meaningful lowercase tokens from a company name. */
function companyTokens(company: string | null | undefined): string[] {
  if (!company) return [];
  return company
    .toLowerCase()
    .replace(/&/g, ' and ')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !GENERIC_COMPANY_TOKENS.has(token));
}

/** True when a host label plausibly names the posting's company. */
export function hostMatchesCompany(host: string, company: string | null | undefined): boolean {
  const tokens = companyTokens(company);
  if (tokens.length === 0) return false;

  const labels = host.split('.');
  return tokens.some((token) =>
    labels.some((label) => label === token || label.startsWith(`${token}-`) || label.endsWith(`-${token}`)),
  );
}

/** Advisory heuristics. A hit means "route to review", never "reject". */
function suspicionReason(host: string, pathname: string): string | null {
  // An `xn--` label is a punycode/IDN host. It can never equal an ASCII list
  // entry, so it cannot pass as trusted — but it also cannot be waved through,
  // because a homoglyph domain is exactly how a lookalike would be presented.
  if (host.split('.').some((label) => label.startsWith('xn--'))) {
    return 'internationalized (punycode) host — needs a human look';
  }

  const collapsed = host.replace(/[^a-z0-9]/g, '');
  const fragment = SUSPICIOUS_HOST_FRAGMENTS.find(
    (entry) => host.includes(entry) || collapsed.includes(entry.replace(/[^a-z0-9]/g, '')),
  );
  if (fragment !== undefined) return `host contains "${fragment}"`;

  if (ARTICLE_SLUG_REGEX.test(pathname)) return 'path looks like an SEO article slug';

  return null;
}

/**
 * Classifies one apply URL.
 *
 * Order matters, and it is the order of certainty. The definite rejections come
 * first — our own domain and a known aggregator host — so no later signal can talk
 * a bad link into acceptance: an aggregator that puts "careers" in a subdomain, or
 * an article path containing `/jobs/`, is still an aggregator. Wrappers come next,
 * because their destination is unknown until resolved and a guess would be worse
 * than an honest "resolve me". Only then are the acceptance rules applied, and
 * anything left over falls to the advisory heuristics and finally to `suspicious`.
 *
 * Pure and synchronous. No network, so it is safe to call on every render, on
 * every write, and in a tight loop over the whole collection.
 */
export function classifyApplyUrl(
  raw: string | null | undefined,
  options: ClassifyOptions = {},
): ApplyUrlClassification {
  const normalizedUrl = normalizeApplyUrl(raw);

  if (normalizedUrl === null) {
    return {
      verdict: 'unresolvable',
      reason: raw?.trim() ? 'not a usable http(s) URL' : 'no URL',
      normalizedUrl: null,
    };
  }

  const url = new URL(normalizedUrl);
  const host = hostOfUrl(normalizedUrl);

  if (host === null || !host.includes('.')) {
    // No dot means no public site — a malformed href from a page's own theme, or
    // an intranet name. `localhost` is caught by the own-domain list below only
    // when it parses, so it is excluded here explicitly.
    return {
      verdict: 'unresolvable',
      reason: 'host is not a public domain name',
      normalizedUrl,
    };
  }

  const pathname = url.pathname;

  if (isOwnHost(host)) {
    return {
      verdict: 'aggregator',
      reason: 'points back at our own site — a loop, not an application',
      normalizedUrl,
    };
  }

  if (isAggregatorHost(host)) {
    return {
      verdict: 'aggregator',
      reason: `${host} is a known job-aggregator domain`,
      normalizedUrl,
    };
  }

  if (isWrapperHost(host)) {
    return {
      verdict: 'wrapper',
      reason: `${host} is a link shortener or redirect wrapper — resolve it before storing`,
      normalizedUrl,
    };
  }

  if (isTrustedAtsHost(host)) {
    return {
      verdict: 'direct',
      reason: hostMatchesCompany(host, options.company)
        ? `${host} is a trusted ATS and the host matches the company`
        : `${host} is a trusted ATS domain`,
      normalizedUrl,
    };
  }

  // A host that only ever serves forms: any path on it is the application.
  if (hostInList(host, FORM_ONLY_HOSTS)) {
    return { verdict: 'direct', reason: 'official application form', normalizedUrl };
  }

  if (hostInList(host, FORM_PATH_HOSTS)) {
    // The bare host is Google Docs or an Airtable base; only a form path applies.
    if (/\/forms?\b|\/viewform|\/pages\/responsepage/i.test(pathname)) {
      return { verdict: 'direct', reason: 'official application form', normalizedUrl };
    }
    return {
      verdict: 'suspicious',
      reason: `${host} without a form path is not an application`,
      normalizedUrl,
    };
  }

  // A third-party job board. Real, but neither the employer nor an ATS, so it is
  // a human's call rather than something published unreviewed.
  if (isJobBoardHost(host)) {
    return {
      verdict: 'suspicious',
      reason: `${host} is a third-party job board, not the employer's own application`,
      normalizedUrl,
    };
  }

  // An official body's own site is the apply route by definition, and it is
  // checked ahead of the advisory heuristics: `drdo.gov.in/recruitment/apply`
  // looks like an article slug to a regex, but a `.gov.in` host settles it.
  if (OFFICIAL_TLD_REGEX.test(host)) {
    return {
      verdict: 'direct',
      reason: 'official government / academic domain',
      normalizedUrl,
    };
  }

  // Heuristics are checked before the remaining employer-shaped acceptances so an
  // aggregator that happens to have `/careers/` in its path is routed to review
  // instead of being accepted on the strength of its path.
  const suspicion = suspicionReason(host, pathname);

  if (suspicion === null) {
    if (hostMatchesCompany(host, options.company)) {
      return {
        verdict: 'direct',
        reason: `${host} matches the posting's company`,
        normalizedUrl,
      };
    }

    if (hasCareerHost(host)) {
      return {
        verdict: 'direct',
        reason: `${host} is a careers host`,
        normalizedUrl,
      };
    }

    if (APPLY_PATH_REGEX.test(pathname)) {
      return {
        verdict: 'direct',
        reason: 'path names a posting or an application form',
        normalizedUrl,
      };
    }
  }

  return {
    verdict: 'suspicious',
    reason: suspicion ?? 'no employer, ATS or application signal — needs review',
    normalizedUrl,
  };
}
