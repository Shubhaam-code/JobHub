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
