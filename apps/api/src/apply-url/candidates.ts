/**
 * Finding the real apply link inside an aggregator's article page.
 *
 * The input is a page we already know is an aggregator article; the output is a
 * ranked list of candidate destinations with a reason attached to each. The
 * decision of what to *do* with that list lives in the backfill (exactly one
 * high-confidence candidate is applied; anything else goes to a human), so this
 * module never writes and never picks a winner on its own.
 *
 * Two rules shape the scoring, both learned from how these pages are actually
 * built:
 *
 *  1. **A candidate must look like a destination.** An aggregator labels half a
 *     dozen links "Apply Now" — its Telegram channel, its YouTube promo, its
 *     placement course. So anchor text alone scores nothing: the URL itself has to
 *     earn a destination signal (a trusted ATS host, a careers host, an employer
 *     host matching the company, an application path) before a label can add to it.
 *  2. **Rejection beats a low score** for links that would be wrong however well
 *     they are labelled — the page's own site, another aggregator, our own site, an
 *     ad network, a share endpoint, a social page, an anchor the page itself marks
 *     `sponsored`.
 *
 * Pure and synchronous: the caller fetches the HTML, so the choice can be tested
 * against a saved page with no network at all.
 */

import { classifyApplyUrl, hostInList, hostMatchesCompany, hostOfUrl, isOwnHost } from './classify.js';
import { type ApplyUrlCandidate } from './status.js';

/**
 * Ad networks, analytics and consent hosts. A link to one is never the job, and it
 * is rejected before any redirect unwrapping so an ad's own landing page cannot be
 * mistaken for an apply link.
 */
const AD_TRACKING_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'amazon-adsystem.com',
  'adnxs.com',
  'adsterra.com',
  'taboola.com',
  'outbrain.com',
  'mgid.com',
  'revcontent.com',
  'media.net',
  'popads.net',
  'propellerads.com',
  'onesignal.com',
];

/** Infrastructure and store links every WordPress theme emits. Harmless, ignored. */
const BOILERPLATE_HOSTS = [
  'wordpress.org',
  'wordpress.com',
  'w.org',
  's.w.org',
  'schema.org',
  'gravatar.com',
  'automattic.com',
  'jetpack.com',
  'gstatic.com',
  'googleapis.com',
  'cloudflare.com',
  'play.google.com',
  'apps.apple.com',
];

/** Audience-growth hosts: a channel, a page, a link-in-bio. Never an application. */
const SOCIAL_HOSTS = [
  'instagram.com',
  'facebook.com',
  'fb.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'threads.net',
  'discord.gg',
  'discord.com',
  'reddit.com',
  'pinterest.com',
  't.me',
  'telegram.me',
  'wa.me',
  'whatsapp.com',
  'chat.whatsapp.com',
];

/** Social sharing endpoints — "share this post on X" — matched on the path. */
const SHARE_PATH_REGEX =
  /\/(?:sharer?(?:\.php)?|share(?:article|-offsite)?|intent\/tweet|pin\/create|submit)(?:[/?]|$)/i;

/** Anchor text that names the application itself. */
const STRONG_APPLY_TEXT_REGEX =
  /\bapply\s*(?:now|here|link|online)?\b|\bapplication\s*(?:link|form|portal)\b|\bclick\s+here\s+to\s+(?:apply|register)\b|\bregistration\s+link\b/i;

/** Anchor text pointing at an official destination without saying "apply". */
const WEAK_APPLY_TEXT_REGEX =
  /\bregist\w*\b|\benroll\w*\b|\bofficial\s+(?:website|site|notification|link|page)\b|\bcareers?\b|\b(?:job|direct)\s+link\b|\bvacanc\w*\b/i;

/** An explicit pointer to a different opportunity is never this article's job. */
const UNRELATED_TEXT_REGEX =
  /\b(?:also|other|similar|related|more|latest|recommended|previous|next)\s+(?:apply|jobs?|openings?|vacanc\w*|posts?)\b|\bapply\s+(?:for|to)\s+(?:other|another|similar|related)\b/i;

/** A path that names a posting or an application form. */
const APPLY_PATH_REGEX =
  /\/(?:careers?|jobs?|job-?de\w+|apply|application|openings?|vacanc\w*|positions?|recruit\w*|forms?|viewform|hcmui|candidate)(?:[/\-_.?=]|$)/i;

/** A bare homepage with no job path — the employer's front door, not the form. */
const BARE_PATH_REGEX = /^\/?$|^\/(?:index|home)\.[a-z]+$/i;

const ATS_SCORE = 5;
const COMPANY_MATCH_SCORE = 4;
const APPLY_PATH_SCORE = 3;
const FORM_SCORE = 2;
const STRONG_TEXT_SCORE = 2;
const WEAK_TEXT_SCORE = 1;

/** Confidence buckets. The backfill only auto-applies `highest`/`high`. */
function bucket(score: number): ApplyUrlCandidate['confidence'] {
  if (score >= ATS_SCORE + COMPANY_MATCH_SCORE) return 'highest';
  if (score >= ATS_SCORE) return 'high';
  if (score >= COMPANY_MATCH_SCORE) return 'medium';
  if (score > 0) return 'low';
  return 'reject';
}

/** The handful of HTML entities that actually turn up inside an href or a label. */
function decodeEntities(value: string): string {
  return value
    .replace(/&(?:amp|#0*38|#[xX]0*26);/g, '&')
    .replace(/&(?:quot|#0*34);/g, '"')
    .replace(/&(?:apos|#0*39);/g, "'")
    .replace(/&(?:lt|#0*60);/g, '<')
    .replace(/&(?:gt|#0*62);/g, '>')
    .replace(/&(?:nbsp|#0*160);/g, ' ');
}

/** Removes the parts of a page whose markup is never article content. */
function stripNonContent(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

/**
 * Narrows the HTML to the article body when the page marks one.
 *
 * Navigation, sidebar, footer and share widgets are where an aggregator keeps its
 * own links, and those are precisely the ones that must not win. When no article
 * container is found the whole document is used, and the per-link rejections below
 * carry the weight instead.
 */
function articleBody(html: string): string {
  const article = /<article\b[^>]*>([\s\S]*?)<\/article\s*>/i.exec(html);
  if (article?.[1] !== undefined && article[1].length > 200) return article[1];

  const entry =
    /<div\b[^>]*class\s*=\s*["'][^"']*(?:entry-content|post-content|article-content|td-post-content|single-content)[^"']*["'][^>]*>([\s\S]*)/i.exec(
      html,
    );
  if (entry?.[1] !== undefined && entry[1].length > 200) return entry[1];

  return html;
}

const ANCHOR_REGEX = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HREF_REGEX = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;
const REL_REGEX = /\brel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

function attribute(attributes: string, regex: RegExp): string | null {
  const match = regex.exec(attributes);
  if (match === null) return null;
  const value = match[1] ?? match[2] ?? match[3];
  return value === undefined ? null : decodeEntities(value.trim());
}

/**
 * Anchor label with nested markup removed: `<b>Apply</b> ➜` → "Apply ➜".
 *
 * Entity references `decodeEntities` does not cover — `&rarr;`, `&raquo;` and the
 * rest of the arrow decorations these buttons are built from — are dropped rather
 * than left as literal text, because this label is shown verbatim to a reviewer.
 */
function anchorLabel(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ' '))
    .replace(/&(?:#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Why a candidate is rejected outright, or null when it is worth scoring. */
function rejectionReason(
  url: string,
  host: string,
  pathname: string,
  label: string,
  rel: string | null,
  pageHost: string,
): string | null {
  if (!host.includes('.')) return 'host is not a public domain name';
  if (host === pageHost || host.endsWith(`.${pageHost}`)) return "the aggregator's own site";
  if (isOwnHost(host)) return 'our own site';
  if (hostInList(host, AD_TRACKING_HOSTS)) return 'ad or tracking network';
  if (hostInList(host, BOILERPLATE_HOSTS)) return 'theme or platform boilerplate';
  if (hostInList(host, SOCIAL_HOSTS)) return 'social or chat link';
  if (SHARE_PATH_REGEX.test(pathname)) return 'share endpoint';
  if (rel !== null && /\bsponsored\b/i.test(rel)) return 'marked rel="sponsored"';
  if (UNRELATED_TEXT_REGEX.test(label)) return 'labelled as a different opportunity';

  const verdict = classifyApplyUrl(url).verdict;
  if (verdict === 'aggregator') return 'another aggregator — would only move the problem';

  return null;
}

export interface ExtractOptions {
  /** The posting's company, used to prefer a host that plausibly belongs to it. */
  company?: string | null;
}

/**
 * Every scorable link on the page, best first.
 *
 * Rejected links are omitted rather than returned with a zero score: the review
 * queue shows this list to a human, and filling it with the page's own navigation
 * would bury the two or three links that matter.
 */
export function extractApplyCandidates(
  html: string,
  pageUrl: string,
  options: ExtractOptions = {},
): ApplyUrlCandidate[] {
  const pageHost = hostOfUrl(pageUrl);
  if (pageHost === null) return [];

  const body = stripNonContent(articleBody(html));
  /** Keyed by normalized URL, so the same link found twice keeps its best score. */
  const found = new Map<string, ApplyUrlCandidate>();

  for (const match of body.matchAll(ANCHOR_REGEX)) {
    const attributes = match[1] ?? '';
    const href = attribute(attributes, HREF_REGEX);
    if (href === null || href.length === 0) continue;

    // Relative hrefs resolve against the article; `#section` and `mailto:` fall
    // out at the classification step below.
    let absolute: string;
    try {
      absolute = new URL(href, pageUrl).toString();
    } catch {
      continue;
    }

    // Rejected by host before the wrapper unwrapping inside `normalizeApplyUrl`,
    // so an ad's `?adurl=` cannot smuggle a target past the ad-network check.
    const rawHost = hostOfUrl(absolute);
    if (rawHost !== null && hostInList(rawHost, AD_TRACKING_HOSTS)) continue;

    const classification = classifyApplyUrl(absolute, { company: options.company });
    const normalized = classification.normalizedUrl;
    if (normalized === null) continue;

    const host = hostOfUrl(normalized);
    if (host === null) continue;

    const url = new URL(normalized);
    const label = anchorLabel(match[2] ?? '');
    const rel = attribute(attributes, REL_REGEX);

    if (rejectionReason(normalized, host, url.pathname, label, rel, pageHost) !== null) continue;

    // ── Destination signals. At least one is required. ──
    const reasons: string[] = [];
    let destination = 0;

    if (classification.verdict === 'direct' && /trusted ATS/i.test(classification.reason)) {
      destination += ATS_SCORE;
      reasons.push('trusted ATS domain');
    }
    if (hostMatchesCompany(host, options.company)) {
      destination += COMPANY_MATCH_SCORE;
      reasons.push('host matches the company');
    }
    if (APPLY_PATH_REGEX.test(url.pathname)) {
      destination += APPLY_PATH_SCORE;
      reasons.push('path names a posting or form');
    }
    if (classification.verdict === 'direct' && /application form/i.test(classification.reason)) {
      destination += FORM_SCORE;
      reasons.push('official application form');
    }

    // A bare homepage is the employer's front door, not the application, so it
    // never counts as a destination on its own.
    if (destination === 0) continue;
    if (BARE_PATH_REGEX.test(url.pathname) && destination <= APPLY_PATH_SCORE) continue;

    let score = destination;
    if (STRONG_APPLY_TEXT_REGEX.test(label)) {
      score += STRONG_TEXT_SCORE;
      reasons.push(`labelled "${label.slice(0, 40)}"`);
    } else if (WEAK_APPLY_TEXT_REGEX.test(label)) {
      score += WEAK_TEXT_SCORE;
      reasons.push(`labelled "${label.slice(0, 40)}"`);
    }

    const candidate: ApplyUrlCandidate = {
      url: normalized,
      finalUrl: null,
      confidence: bucket(score),
      score,
      reason: reasons.join('; '),
      label: label.length > 0 ? label.slice(0, 120) : null,
    };

    const existing = found.get(normalized);
    if (existing === undefined || candidate.score > existing.score) {
      found.set(normalized, candidate);
    }
  }

  // Descending by score; URL breaks ties so the same page always ranks the same way.
  return [...found.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

/**
 * The single candidate safe to apply without a human, or null.
 *
 * Deliberately strict, because this is the one place the system changes a live
 * apply link on its own. Three conditions, all required:
 *
 *  - the best candidate is `high` or `highest` confidence;
 *  - no other candidate is within one point of it, so there is no genuine tie;
 *  - and it is not merely the strongest of several equally plausible guesses.
 *
 * Anything else is a review-queue item. A wrong apply button is worse than an
 * empty one, so ambiguity always resolves to "ask a human".
 */
export function pickConfidentCandidate(
  candidates: readonly ApplyUrlCandidate[],
): ApplyUrlCandidate | null {
  const best = candidates[0];
  if (best === undefined) return null;
  if (best.confidence !== 'high' && best.confidence !== 'highest') return null;

  const runnerUp = candidates[1];
  if (runnerUp !== undefined && best.score - runnerUp.score <= 1) return null;

  return best;
}
