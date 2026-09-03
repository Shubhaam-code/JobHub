/**
 * Finding a company's logo from nothing but the company name.
 *
 * The pipeline already extracts `company` from a post, and every card in the UI
 * draws a monogram beside it. This module turns that name into a logo URL:
 *
 *   "Zoho Corporation" → zoho.com → provider URL → verified image → stored
 *
 * Four rules keep it away from everything that already works:
 *
 *  1. It is optional. Every entry point is total and failure-safe: a disabled
 *     switch, an unusable name, a blocked request, a timeout or a 404 all answer
 *     `null`, which the UI already handles — that is the monogram it draws today.
 *  2. A guessed domain has to be verified twice before it is trusted. The
 *     provider is asked for the icon, and then the domain's own homepage is asked
 *     who owns it. The second check exists because the first cannot fail the way
 *     it needs to: the provider serves an icon for any *registered* domain, so
 *     upsc.in (a for-sale lander), indigo.com (a Canadian bookstore) and
 *     larsenandtoubro.com (a HugeDomains page) all pass it. The homepage check is
 *     what rejects them — and what lets a rebrand through, since
 *     microntechnology.com redirects to micron.com.
 *  3. Placeholder company names ("Confidential", "MNC", "Various") are rejected
 *     before any request, because a logo for them would be a logo for the wrong
 *     company.
 *  4. One lookup per company, not per job. Results — including the misses — are
 *     cached in this process, and the worker can hand in a logo already stored
 *     on an earlier job for the same company, so a channel posting forty roles
 *     for one employer costs at most one request.
 *
 * Nothing here reads or writes MongoDB: the caller supplies what it already
 * knows. That keeps this module pure enough to test without a database and
 * without the network.
 */

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/** Placeholder for the guessed hostname inside `COMPANY_LOGO_PROVIDER_URL`. */
const DOMAIN_PLACEHOLDER = '{domain}';

/**
 * Words that are a legal entity, not part of the name a domain is built from.
 * Deliberately short: "Technologies", "Solutions" and "India" stay, because they
 * are usually part of the real hostname.
 */
const LEGAL_SUFFIX_REGEX =
  /\b(?:private|pvt|pvt\.|limited|ltd|inc|incorporated|llc|llp|plc|gmbh|ag|sa|bv|corp|corporation|co)\b/g;

/**
 * Names that identify no company at all. A logo for one of these would be a
 * logo for whoever happens to own the matching domain, which is worse than the
 * monogram the UI already draws.
 */
const PLACEHOLDER_NAME_REGEX =
  /^(?:confidential|undisclosed|unknown|n\s*a|none|null|nil|tbd|various|multiple|several|mnc|mncs|startup|start[\s-]?up|company|companies|client|clients|employer|organisation|organization|org|firm|hiring|recruiter|recruitment|consultancy|consultant|top\s+(?:mnc|companies|product)|(?:product|service)[\s-]based(?:\s+company)?|not\s+(?:specified|mentioned|disclosed|available)|multiple\s+companies|leading\s+\w+)$/i;

/** Bracketed asides and trailing noise a channel writes into a company name. */
const PARENTHETICAL_REGEX = /[([{][^)\]}]*[)\]}]/g;
const TRAILING_NOISE_REGEX =
  /\b(?:off[\s-]?campus|on[\s-]?campus|drive|driving|hiring|recruitment|recruiting|careers?|jobs?|internships?|opening|openings|vacancy|vacancies|walk[\s-]?in|batch|freshers?|20\d\d)\b/gi;

/** A company name written as a domain already ("zoho.com", "byjus.in"). */
const DOMAIN_LIKE_REGEX = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/;

/**
 * Companies whose real hostname cannot be guessed from the name, keyed by
 * `companyLogoCacheKey`.
 *
 * Two kinds of entry, and both exist because a guess was observed to be wrong:
 *
 *  - The guess resolves to nothing. "Deutsche Bank" → deutschebank.com does not
 *    answer at all; the bank is db.com.
 *  - The guess resolves to a *different* company, which is the failure worth
 *    preventing: "IndiGo" → indigo.com is a Canadian bookstore, "India Post" →
 *    indiapost.com is a newspaper, "Larsen & Toubro" → larsenandtoubro.com is a
 *    domain-for-sale page.
 *
 * An entry here is used as-is and skips the page verification below, because the
 * hostname was checked by hand rather than inferred. Some of these have no icon
 * at the provider (sbi.co.in, tcs.com) — that is the intended outcome: the card
 * keeps its monogram instead of showing another company's mark.
 */
const KNOWN_COMPANY_DOMAINS = new Map<string, string>([
  ['hpe', 'hpe.com'],
  ['hewlettpackardenterprise', 'hpe.com'],
  ['deutschebank', 'db.com'],
  ['larsenandtoubro', 'larsentoubro.com'],
  ['larsentoubro', 'larsentoubro.com'],
  ['landt', 'larsentoubro.com'],
  ['indigo', 'goindigo.in'],
  ['goindigo', 'goindigo.in'],
  ['indiapost', 'indiapost.gov.in'],
  ['isro', 'isro.gov.in'],
  ['upsc', 'upsc.gov.in'],
  ['sbi', 'sbi.co.in'],
  ['statebankofindia', 'sbi.co.in'],
  ['tcs', 'tcs.com'],
  ['tataconsultancyservices', 'tcs.com'],
  ['micron', 'micron.com'],
  ['microntechnology', 'micron.com'],
  ['fujitsu', 'global.fujitsu'],
  ['zeta', 'zeta.tech'],
  ['weekday', 'weekday.works'],
  ['weekdayworks', 'weekday.works'],
  ['yash', 'yash.com'],
  ['yashtechnologies', 'yash.com'],
  ['iocl', 'iocl.com'],
  ['indianoil', 'iocl.com'],
  ['johnsonandjohnson', 'jnj.com'],
]);

/**
 * Text on a page that is not a company's site: a registrar's parking page, a
 * for-sale lander, or a placeholder.
 *
 * This is the check that catches a guess which resolves to a *registered but
 * unused* domain — the case the icon provider cannot distinguish, since it
 * serves an icon for any registered domain. upsc.in, myntra.in, lgsolution.com
 * and isro.com are all live, all have icons, and all are parked.
 */
const PARKED_PAGE_REGEX =
  /(?:this\s+(?:web\s*site|website|domain)\s+is\s+for\s+sale|domain\s+(?:name\s+)?(?:is\s+)?for\s+sale|buy\s+this\s+domain|the\s+domain\s+name\s+[a-z0-9.-]+|hugedomains|sedoparking|afternic|domain\s+parking|parked\s+free|inquire\s+about\s+this\s+domain)/i;

/** Shortest compacted name worth a lookup — "HP" is real, "H" is not. */
const MIN_COMPACT_LENGTH = 2;
/** Longest compacted name worth a lookup; past this it is a sentence, not a name. */
const MAX_COMPACT_LENGTH = 40;

/** How long a found logo is trusted inside this process. */
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * How long a miss is remembered. Shorter than a hit on purpose: a company whose
 * domain could not be verified today may be verifiable after a provider blip,
 * and a long-lived miss would hide that for the life of the process.
 */
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;

export interface CompanyLogoResolution {
  /** The verified logo URL, or null when there is none to show. */
  url: string | null;
  /** Where the answer came from. `skipped` means no request was made. */
  source: 'cache' | 'stored' | 'network' | 'skipped';
  /** Why nothing was found. Set only when a lookup happened and failed. */
  reason?: string;
}

export interface ResolveCompanyLogoOptions {
  /**
   * A logo already stored for this company (e.g. read off an earlier job).
   * Accepted as-is and cached, so a restarted process does not re-probe every
   * company it has already resolved once.
   */
  storedLogoUrl?: string | null;
  /** Provider probe. Overridden only in tests. */
  probe?: (url: string) => Promise<boolean>;
  /** Homepage ownership check. Overridden only in tests. */
  checkDomainOwner?: (domain: string) => Promise<DomainOwnerCheck>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The company name reduced to comparable words: brackets, punctuation and
 * entity suffixes gone, "&" spelled out, whitespace collapsed.
 *
 * Returns an empty string for anything that is not usable as a name — which is
 * what every caller below treats as "no lookup".
 */
export function normalizeCompanyName(company: string | null | undefined): string {
  const raw = (company ?? '').trim();
  if (raw.length === 0) return '';

  const cleaned = raw
    .toLowerCase()
    .replace(PARENTHETICAL_REGEX, ' ')
    .replace(/&/g, ' and ')
    .replace(TRAILING_NOISE_REGEX, ' ')
    // Keep dots for a name already written as a domain; drop other punctuation.
    .replace(/[^a-z0-9.\s-]/g, ' ')
    .replace(LEGAL_SUFFIX_REGEX, ' ')
    .replace(/[\s-]+/g, ' ')
    .replace(/\s*\.\s*/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .trim();

  return cleaned;
}

/** Cache key for a company. Same name in any casing or spacing is one key. */
export function companyLogoCacheKey(company: string | null | undefined): string {
  return normalizeCompanyName(company).replace(/\s+/g, '');
}

/**
 * True when the name identifies a real employer worth one provider request.
 *
 * The placeholder check runs on the normalized name, so "Confidential (MNC)"
 * and "confidential" are the same rejection.
 */
export function isLogoWorthyCompany(company: string | null | undefined): boolean {
  const normalized = normalizeCompanyName(company);
  if (normalized.length === 0) return false;
  if (PLACEHOLDER_NAME_REGEX.test(normalized)) return false;

  const compact = normalized.replace(/[\s.]/g, '');
  if (compact.length < MIN_COMPACT_LENGTH) return false;
  if (compact.length > MAX_COMPACT_LENGTH) return false;
  // A name with no letter at all ("2026", "---") is not a company.
  if (!/[a-z]/.test(compact)) return false;

  return true;
}

/**
 * Hostnames to try for a company name, best guess first.
 *
 * Only the whole name is ever compacted into a host — never a single word out of
 * a multi-word name. "Bank of America" must not become `bank.com`, and taking
 * the first word is exactly how that happens. A name that does not resolve
 * simply gets no logo, which is the documented fallback.
 */
export function companyDomainCandidates(company: string | null | undefined): string[] {
  if (!isLogoWorthyCompany(company)) return [];

  const known = KNOWN_COMPANY_DOMAINS.get(companyLogoCacheKey(company));
  if (known !== undefined) return [known];

  const normalized = normalizeCompanyName(company);

  // Already a domain: trust it rather than rebuilding one from its own parts.
  if (!normalized.includes(' ') && DOMAIN_LIKE_REGEX.test(normalized)) {
    return [normalized.replace(/^www\./, '')];
  }

  const compact = normalized.replace(/[\s.]/g, '');
  if (compact.length < MIN_COMPACT_LENGTH) return [];

  return [`${compact}.com`, `${compact}.in`, `${compact}.co.in`];
}

/** True when the hostname was curated by hand rather than guessed from the name. */
export function isKnownCompanyDomain(company: string | null | undefined): boolean {
  return KNOWN_COMPANY_DOMAINS.has(companyLogoCacheKey(company));
}

/** The provider URL for one hostname. */
export function companyLogoUrl(domain: string): string {
  const template = env.COMPANY_LOGO_PROVIDER_URL;

  return template.includes(DOMAIN_PLACEHOLDER)
    ? template.replaceAll(DOMAIN_PLACEHOLDER, encodeURIComponent(domain))
    : `${template.replace(/\/+$/, '')}/${encodeURIComponent(domain)}`;
}

/* ── In-process cache ─────────────────────────────────────────────────────── */

interface CacheEntry {
  url: string | null;
  expiresAt: number;
}

/**
 * One entry per company, hits and misses alike, bounded by
 * `COMPANY_LOGO_CACHE_MAX`.
 *
 * Bounded because the key space is "every company name any channel ever posts",
 * which grows forever — the same reason the Telegram entity store is capped. A
 * Map iterates in insertion order, so evicting from the front drops the oldest.
 */
const cache = new Map<string, CacheEntry>();

function readCache(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (entry === undefined) return null;

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }

  return entry;
}

function writeCache(key: string, url: string | null): void {
  cache.set(key, {
    url,
    expiresAt: Date.now() + (url === null ? NEGATIVE_TTL_MS : POSITIVE_TTL_MS),
  });

  while (cache.size > env.COMPANY_LOGO_CACHE_MAX) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
}

/** Empties the cache. For tests, and for a script that wants a cold run. */
export function clearCompanyLogoCache(): void {
  cache.clear();
}

/* ── Provider probe ───────────────────────────────────────────────────────── */

/**
 * Identifies this app, the way the apply-URL resolver does. Sending no
 * User-Agent is what most hosts refuse outright.
 */
const USER_AGENT = 'Mozilla/5.0 (compatible; JobHubBot/1.0; +https://github.com/jobhub)';

/**
 * True when the provider really has an icon for this URL.
 *
 * `HEAD` first because the answer is in the status and the content type — the
 * bytes are never needed here, and not downloading them keeps the worker's
 * memory flat. A provider that refuses `HEAD` is retried with `GET`, whose body
 * is cancelled without being read.
 *
 * Never throws: a timeout, a DNS failure or a refused connection is "no logo".
 */
async function probeLogo(url: string): Promise<boolean> {
  const timeoutMs = env.COMPANY_LOGO_TIMEOUT_MS;

  async function attempt(method: 'HEAD' | 'GET'): Promise<boolean | 'retry'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: { 'user-agent': USER_AGENT, accept: 'image/*' },
        signal: controller.signal,
      });

      // Nothing here reads the body, so release the socket either way.
      await response.body?.cancel().catch(() => undefined);

      if (response.status === 405 || response.status === 501) {
        return method === 'HEAD' ? 'retry' : false;
      }
      if (!response.ok) return false;

      const contentType = response.headers.get('content-type');
      return contentType === null || /image\//i.test(contentType);
    } catch (error: unknown) {
      logger.debug(`[company-logo] probe ${method} ${url} failed → ${errorText(error)}`);
      return method === 'HEAD' ? 'retry' : false;
    } finally {
      clearTimeout(timer);
    }
  }

  const head = await attempt('HEAD');
  if (head !== 'retry') return head;

  const get = await attempt('GET');
  return get === true;
}

/* ── Domain ownership check ───────────────────────────────────────────────── */

/**
 * A browser User-Agent for the homepage fetch.
 *
 * Unlike the icon provider, a company's own site is often behind a WAF that
 * serves a challenge page to anything that identifies itself as a bot, and a
 * challenge page carries none of the signals this check reads.
 */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Bytes of HTML read before the body is cancelled. `<head>` is all that matters. */
const HOMEPAGE_READ_LIMIT = 60_000;

/** What a guessed domain's homepage says about who owns it. */
export interface DomainOwnerCheck {
  /** False when the page could not be reached at all. */
  reachable: boolean;
  /** Hostname after redirects — a rebrand lands here (microntechnology → micron). */
  finalHost: string;
  /** `og:site_name` if present, else `<title>`. */
  siteName: string;
  /** True when the page is a registrar parking or for-sale lander. */
  parked: boolean;
}

/** Letters and digits only, for comparing a name against a page's own text. */
function compactWord(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Reads the identifying parts of a domain's homepage.
 *
 * Never throws, and never reads more than `HOMEPAGE_READ_LIMIT` bytes: a DNS
 * failure, a TLS mismatch, a timeout or a 5xx all come back as
 * `reachable: false`, which the caller treats as "not this company's domain".
 */
async function fetchDomainOwner(domain: string): Promise<DomainOwnerCheck> {
  const unreachable: DomainOwnerCheck = {
    reachable: false,
    finalHost: '',
    siteName: '',
    parked: false,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.COMPANY_LOGO_TIMEOUT_MS);

  try {
    const response = await fetch(`https://${domain}/`, {
      redirect: 'follow',
      headers: {
        'user-agent': BROWSER_USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });

    let html = '';
    const reader = response.body?.getReader();

    if (reader !== undefined) {
      try {
        const chunks: Uint8Array[] = [];
        let total = 0;

        while (total < HOMEPAGE_READ_LIMIT) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            chunks.push(value);
            total += value.length;
          }
        }

        html = Buffer.concat(chunks).toString('utf8');
      } catch {
        // A truncated read still leaves whatever arrived usable.
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }

    // A 5xx says nothing about ownership; a 403/429 challenge page is common on a
    // real company site, so those are still read for their host and title.
    if (response.status >= 500) return unreachable;

    const title = /<title[^>]*>([^<]{0,300})/i.exec(html)?.[1] ?? '';
    const ogSiteName =
      /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{0,200})["']/i.exec(html)?.[1] ??
      '';

    return {
      reachable: true,
      finalHost: new URL(response.url).hostname.replace(/^www\./, ''),
      siteName: (ogSiteName || title).replace(/\s+/g, ' ').trim(),
      parked: PARKED_PAGE_REGEX.test(html.slice(0, HOMEPAGE_READ_LIMIT)),
    };
  } catch (error: unknown) {
    logger.debug(`[company-logo] homepage ${domain} unreachable → ${errorText(error)}`);
    return unreachable;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when `check` describes a page that plausibly belongs to `company`.
 *
 * The icon provider serves an icon for any *registered* domain, so it cannot tell
 * a company's site from a parked one. This is the check that can: the page must
 * be reachable, must not be a for-sale lander, and its name or final hostname
 * must contain the company name (or vice versa).
 *
 * Containment rather than equality, in both directions, because a real title is
 * rarely just the name — "Micron Technology | Global Leader in Memory…" contains
 * "micron", and "Zoho" is contained by "zohocorp.com". That tolerance is what
 * keeps the false-negative rate low; the parked and unreachable checks are what
 * keep the false positives out.
 */
export function domainMatchesCompany(
  company: string | null | undefined,
  domain: string,
  check: DomainOwnerCheck,
): boolean {
  if (!check.reachable) return false;
  if (check.parked) return false;

  const name = compactWord(normalizeCompanyName(company));
  if (name.length < MIN_COMPACT_LENGTH) return false;

  const haystacks = [compactWord(check.siteName)];

  // The final hostname is only evidence when the site redirected somewhere else:
  // an unredirected host is just the guess spelled back, so matching the name
  // against it would accept every registered domain. This is what distinguishes
  // a rebrand (microntechnology.com → micron.com) from a coincidence
  // (tower.com staying tower.com).
  const guessed = compactWord(domain);
  const landed = compactWord(check.finalHost);
  if (landed.length > 0 && landed !== guessed) haystacks.push(landed);

  return haystacks.some(
    (text) => text.length > 0 && (text.includes(name) || name.includes(text)),
  );
}

/* ── Resolution ───────────────────────────────────────────────────────────── */

/**
 * Finds the logo for one company.
 *
 * Total and failure-safe: every path returns a resolution, and `url: null` is a
 * perfectly ordinary answer that means "draw the fallback". A caller never has
 * to catch anything, and no caller's own work can fail because of this one.
 *
 * A logo already stored for the company (`storedLogoUrl`) short-circuits the
 * whole thing, which is what keeps the number of provider requests at one per
 * company rather than one per job.
 */
export async function resolveCompanyLogo(
  company: string | null | undefined,
  options: ResolveCompanyLogoOptions = {},
): Promise<CompanyLogoResolution> {
  if (!env.COMPANY_LOGO_ENABLED) {
    return { url: null, source: 'skipped' };
  }

  if (!isLogoWorthyCompany(company)) {
    return { url: null, source: 'skipped' };
  }

  const key = companyLogoCacheKey(company);

  const stored = options.storedLogoUrl?.trim();
  if (stored !== undefined && stored.length > 0) {
    // Reused as-is: it was verified when it was first found, and re-probing it
    // would spend a request to learn something already known.
    writeCache(key, stored);
    return { url: stored, source: 'stored' };
  }

  const cached = readCache(key);
  if (cached !== null) {
    return {
      url: cached.url,
      source: 'cache',
      ...(cached.url === null ? { reason: 'no verified logo for this company (cached)' } : {}),
    };
  }

  const probe = options.probe ?? probeLogo;
  const checkOwner = options.checkDomainOwner ?? fetchDomainOwner;
  const candidates = companyDomainCandidates(company);
  const curated = isKnownCompanyDomain(company);

  let rejected = 0;

  for (const domain of candidates) {
    const url = companyLogoUrl(domain);

    let verified = false;
    try {
      verified = await probe(url);
    } catch (error: unknown) {
      // A custom probe is allowed to throw; this one treats it as a miss so the
      // caller's job still completes.
      logger.debug(`[company-logo] probe threw for ${domain} → ${errorText(error)}`);
      verified = false;
    }

    if (!verified) continue;

    // The provider has an icon, which only proves the domain is registered. For a
    // guessed hostname that is not enough: ask the domain itself who it belongs
    // to. A curated hostname skips this — it was checked by hand.
    if (!curated) {
      let owner: DomainOwnerCheck;
      try {
        owner = await checkOwner(domain);
      } catch (error: unknown) {
        logger.debug(`[company-logo] owner check threw for ${domain} → ${errorText(error)}`);
        owner = { reachable: false, finalHost: '', siteName: '', parked: false };
      }

      if (!domainMatchesCompany(company, domain, owner)) {
        rejected += 1;
        logger.debug(
          `[company-logo] ${String(company)} ✗ ${domain} — ` +
            (owner.reachable
              ? `${owner.parked ? 'parked' : 'belongs to'} "${owner.siteName || owner.finalHost}"`
              : 'unreachable'),
        );
        continue;
      }
    }

    writeCache(key, url);
    logger.debug(`[company-logo] ${String(company)} → ${url}`);
    return { url, source: 'network' };
  }

  writeCache(key, null);

  return {
    url: null,
    source: 'network',
    reason:
      candidates.length === 0
        ? 'no usable domain guess for this company'
        : rejected > 0
          ? `${rejected} of ${candidates.length} domain(s) had an icon but belong to someone else`
          : `no logo found for ${candidates.join(', ')}`,
  };
}

/**
 * `resolveCompanyLogo` reduced to "the URL, or null".
 *
 * The shape the ingestion path wants: it cannot throw, so a logo lookup can be
 * dropped into the middle of storing a job without giving that write a new way
 * to fail.
 */
export async function findCompanyLogoUrl(
  company: string | null | undefined,
  options: ResolveCompanyLogoOptions = {},
): Promise<string | null> {
  try {
    return (await resolveCompanyLogo(company, options)).url;
  } catch (error: unknown) {
    logger.warn(`[company-logo] lookup failed for ${String(company)} → ${errorText(error)}`);
    return null;
  }
}
