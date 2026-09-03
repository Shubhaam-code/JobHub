/**
 * Deterministic safety helpers for Telegram post text.
 *
 * Pure functions — no I/O, no side effects, no channel awareness. These run on
 * both sides of the LLM: the pre-filter uses them to spot obvious promotion
 * noise, and the classifier uses them to reject unsafe or invented LLM output.
 */

/** Matches http:// and https:// URLs in text. */
export const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

/** Any link-looking fragment, including scheme-less ones. */
export const LINK_HINT_REGEX = /(https?:\/\/|www\.\w|\bt\.me\/|\blnkd\.in\/)/i;

/**
 * Values that are promotion/contact artifacts rather than job data: a bare
 * Telegram handle, a channel/group link, or an ad/collab CTA. Channels
 * routinely end posts with these, and they must never become a company,
 * a role, or an apply URL.
 */
const PROMOTION_VALUE_REGEXES = [
  /^@[\w]+$/, // "@jobsvillaa"
  /(?:^|\/\/|\s)(?:www\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i, // t.me/... anywhere
  /\b(?:whats\s*app|whatsapp|wa\.me|chat\.whatsapp\.com)\b/i,
  /\b(?:collabs?|collaborations?|promotions?|promote|advertis\w*|sponsor\w*)\b/i,
  /\bjoin\s+(?:now|us|our|the|this)\b/i,
  /\bsubscribe\b/i,
  /^(?:dm|dm\s+.*)$/i,
  /\bmessage\s+(?:here|me|us)\b/i,
];

/** True when a value is promotional/contact noise instead of job data. */
export function isPromotionalValue(value: string): boolean {
  return PROMOTION_VALUE_REGEXES.some((regex) => regex.test(value));
}

/**
 * Returns true when a URL uses a safe scheme (http or https).
 * Rejects javascript:, data:, file:, etc.
 */
export function isSafeUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Hosts that identify a chat/channel link rather than an application form. */
const CHAT_HOSTS = new Set([
  't.me',
  'telegram.me',
  'telegram.dog',
  'telegram.org',
  'wa.me',
  'whatsapp.com',
  'chat.whatsapp.com',
  'api.whatsapp.com',
]);

/**
 * True for Telegram/WhatsApp links (`t.me/jobsvillaa`, `chat.whatsapp.com/…`).
 *
 * Channels link to themselves and to partner channels constantly — under
 * "Join Now", "DM for collab", or simply as the last line of a post. Those are
 * source/promotion links, never job application URLs, so they are excluded
 * from every applyUrl candidate path.
 */
export function isChatUrl(urlString: string): boolean {
  try {
    const host = new URL(urlString).hostname.toLowerCase().replace(/^www\./, '');
    return CHAT_HOSTS.has(host);
  } catch {
    return false;
  }
}

/** A usable application URL: http(s) and not a chat/channel link. */
export function isApplyUrlCandidate(urlString: string): boolean {
  return isSafeUrl(urlString) && !isChatUrl(urlString);
}

/**
 * Hosts whose links grow an audience rather than accept an application.
 * LinkedIn is deliberately absent: `linkedin.com/jobs/view/…` is a real posting,
 * so it is judged by path below instead of by host.
 */
const SOCIAL_HOSTS = new Set([
  'instagram.com',
  'instagr.am',
  'facebook.com',
  'm.facebook.com',
  'fb.com',
  'fb.me',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'threads.net',
  'discord.gg',
  'discord.com',
  'reddit.com',
  'pinterest.com',
  'snapchat.com',
  'sharechat.com',
]);

/** LinkedIn paths that are a page or a profile rather than a posting. */
const LINKEDIN_NON_JOB_PATH = /^\/(?:company|in|school|showcase|feed|groups|newsletters)\//i;

/**
 * True for social/profile links: an Instagram page, a YouTube channel, a
 * LinkedIn company page. Those are promotion, never an application form.
 */
export function isSocialUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    if (SOCIAL_HOSTS.has(host)) return true;

    if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) {
      return LINKEDIN_NON_JOB_PATH.test(url.pathname);
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Link-in-bio and link-wrapper services: one page of the channel's own links.
 *
 * Never an application form, and it cannot be judged by the destination it hides —
 * `yt.openinapp.co/job4freshers-yt` is a YouTube channel wearing a host that looks
 * like a job link, and `linktr.ee/job4freshers.co_in` carries "job" in its path.
 * Matched by suffix, because these services put the customer on a subdomain.
 */
const LINK_WRAPPER_HOSTS = [
  'openinapp.co',
  'linktr.ee',
  'bio.link',
  'beacons.ai',
  'linkin.bio',
  'lnk.bio',
  'campsite.bio',
  'carrd.co',
  'taplink.cc',
  'komi.io',
  'linkpop.com',
  'solo.to',
  'allmylinks.com',
];

/** True for a link-in-bio page (`linktr.ee/…`, `yt.openinapp.co/…`). */
export function isLinkWrapperUrl(urlString: string): boolean {
  try {
    const host = new URL(urlString).hostname.toLowerCase().replace(/^www\./, '');
    return LINK_WRAPPER_HOSTS.some((wrapper) => host === wrapper || host.endsWith(`.${wrapper}`));
  } catch {
    return false;
  }
}

/**
 * True for any link that exists to gather followers — a Telegram/WhatsApp chat,
 * a social page, or a link-in-bio page collecting all three. These are stripped
 * from post text and can never become an applyUrl.
 */
export function isPromotionalUrl(urlString: string): boolean {
  return isChatUrl(urlString) || isSocialUrl(urlString) || isLinkWrapperUrl(urlString);
}

/** Every http(s) URL in the text, in order of appearance. */
export function extractUrls(text: string): string[] {
  return text.match(URL_REGEX)?.map((url) => url.trim()) ?? [];
}

/**
 * Normalises text for grounding checks: lowercase, punctuation and whitespace
 * collapsed away. Lets "Software Engineering Intern" be matched against
 * "*Software  Engineering-Intern*" without accepting invented values.
 */
export function normalizeForGrounding(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * True when `value` actually occurs in `text` (ignoring case, punctuation and
 * whitespace). The anti-hallucination check: an extracted field the post never
 * contained is a fabrication, whatever the model claims.
 */
export function isGroundedIn(value: string, text: string): boolean {
  const needle = normalizeForGrounding(value);
  if (needle.length === 0) return false;
  return normalizeForGrounding(text).includes(needle);
}
