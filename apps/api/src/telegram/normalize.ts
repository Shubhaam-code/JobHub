/**
 * Deterministic normalization of a raw Telegram post — runs BEFORE the LLM.
 *
 * Two jobs, neither of which is allowed to depend on a model:
 *
 *  1. Produce `cleanedText`: the post with channel promotion removed
 *     ("Join Our Official WhatsApp Channel", t.me/… links, social pages) so
 *     users never read an ad and the LLM never classifies one.
 *  2. Produce `applyUrl`: the application link, copied character for character
 *     out of the raw message.
 *
 * The guiding rule is "never destroy a legitimate application URL": a line that
 * still holds a plausible apply link is always sanitized rather than dropped,
 * even when it also carries a promo CTA.
 *
 * Pure functions — no I/O, no channel awareness, no model calls.
 */

import {
  URL_REGEX,
  extractUrls,
  isApplyUrlCandidate,
  isPromotionalUrl,
} from './text-safety.js';

export interface NormalizedMessage {
  /** Post text with promotion removed. What users see and the LLM reads. */
  cleanedText: string;
  /** Application URL exactly as the post wrote it, or null when it has none. */
  applyUrl: string | null;
  /** Promotional links stripped out. Logged for auditing, never displayed. */
  removedUrls: string[];
  /** How many whole lines were dropped as promotion. */
  removedLines: number;
}

/**
 * Lines that exist only to grow an audience. Matched against a whole line, and
 * only after the line has been shown to hold no application link.
 */
const PROMOTIONAL_LINE_REGEXES: RegExp[] = [
  /\bjoin\s+(?:our|the|this|us|my|now)?\s*(?:official\s+)?(?:whats\s*app|telegram|insta\w*|youtube|discord|linked\s*in)?\s*(?:channel|group|community|network|family|page|server)\b/i,
  /\bjoin\s+(?:our|the|this|us|my)\s+(?:official\s+)?(?:whats\s*app|telegram)\b/i,
  /\b(?:official\s+)?(?:whats\s*app|telegram)\s+(?:channel|group)\b/i,
  /\bfollow\s+(?:us|our|me|on|for)\b/i,
  /\bsubscribe\b/i,
  /\b(?:dm|message|contact|ping)\s+(?:me|us|here|for)\b/i,
  /\bfor\s+(?:paid\s+)?(?:promotions?|collabs?|collaborations?|advertisement|sponsorship)\b/i,
  /\b(?:paid\s+)?(?:promotion|collab|advertis\w*|sponsor\w*)\s+(?:enquir\w+|quer\w+|only)\b/i,
  /\bshare\s+(?:it\s+|this\s+)?(?:with|to)\s+(?:your\s+)?(?:friends|groups?|batchmates|colleagues|contacts|needy|juniors)\b/i,
  /\bdaily\s+(?:job|internship|hiring|tech|off[\s-]*campus|placement)\s+(?:updates?|alerts?|posts?)\b/i,
  /\bstay\s+tuned\b/i,
  /\b(?:click|tap)\s+(?:here\s+)?to\s+join\b/i,
  /\blike\s*,?\s*share\b/i,
  /\b(?:all\s+the\s+best|best\s+of\s+luck|happy\s+applying)\b/i,
  /\bmore\s+(?:jobs?|updates?|opportunities)\s*[:\-–—]?\s*$/i,
];

/**
 * Promo fragments removed from INSIDE a line that is being kept because it also
 * carries a genuine apply link. Deliberately narrower than the line rules: a
 * mid-line edit must not be able to eat job data.
 */
const INLINE_PROMO_REGEXES: RegExp[] = [
  /(?:join|follow)\s+(?:our|the|us|my)?\s*(?:official\s+)?(?:whats\s*app|telegram|insta\w*|youtube|linked\s*in)\s*(?:channel|group|page|community)?\s*(?:for\s+\w+(?:\s+\w+){0,3})?\s*[:\-–—]*/gi,
  /(?:official\s+)?(?:whats\s*app|telegram)\s+(?:channel|group)(?:\s+link)?\s*[:\-–—]*/gi,
  /subscribe\s+(?:to\s+)?(?:our\s+)?(?:youtube|channel)?\s*[:\-–—]*/gi,
  /click\s+here\s+to\s+join\s*[:\-–—]*/gi,
];

/** A bare Telegram-style handle, e.g. "@jobsvillaa". */
const BARE_HANDLE_REGEX = /(^|\s)@[A-Za-z0-9_]{3,32}\b/g;

/** Decorative separators channels use as visual dividers. */
const DIVIDER_LINE_REGEX = /^[\s\-=_*~•·#—–➖▬]{2,}$/u;

/** True when nothing meaningful is left: punctuation, emoji or bullets only. */
const NO_CONTENT_REGEX = /[\p{L}\p{N}]/u;

/** Leading decoration on a line ("🔹 ", "👉", "- ", "• "). */
const LEADING_DECORATION_REGEX = /^[\s\p{Extended_Pictographic}\u2000-\u3300•·▪◾◽●○*\-–—>]+/u;

/** Trailing punctuation that follows a URL rather than belonging to it. */
const URL_TRAILING_PUNCTUATION = /[.,;:!?…"')\]}]+$/;

/** Words near a link that mark it as the thing you apply through. */
const APPLY_CONTEXT_REGEX =
  /\b(?:apply|application|register|registration|enroll|link|form|career|jobs?|hiring|vacanc\w+|direct|website|portal|drive)\b/i;

/** Hosts and paths that are application systems by construction. */
const APPLY_TARGET_REGEX =
  /(?:careers?|jobs?|apply|recruit\w*|hiring|workday|myworkdayjobs|greenhouse\.io|lever\.co|smartrecruiters|taleo|successfactors|icims|zohorecruit|freshteam|keka|darwinbox|naukri|internshala|unstop|forms\.gle|docs\.google\.com\/forms|linkedin\.com\/jobs|lnkd\.in|indeed|glassdoor|talent|oraclecloud|ashbyhq|wellfound|instahyre|cutshort|joinsuperset)/i;

/** Strips trailing sentence punctuation so the href actually resolves. */
function trimUrl(url: string): string {
  return url.replace(URL_TRAILING_PUNCTUATION, '');
}

function isPromotionalLine(line: string): boolean {
  return PROMOTIONAL_LINE_REGEXES.some((regex) => regex.test(line));
}

/**
 * Removes promotional URLs, promo fragments and bare handles from a line that is
 * being kept, then tidies the leftover decoration.
 */
function sanitizeLine(line: string, removedUrls: string[]): string {
  let cleaned = line.replace(URL_REGEX, (url) => {
    if (isPromotionalUrl(trimUrl(url))) {
      removedUrls.push(trimUrl(url));
      return ' ';
    }
    return url;
  });

  for (const regex of INLINE_PROMO_REGEXES) {
    cleaned = cleaned.replace(regex, ' ');
  }

  cleaned = cleaned.replace(BARE_HANDLE_REGEX, '$1');
  cleaned = cleaned.replace(LEADING_DECORATION_REGEX, '');
  // Collapse runs of spaces/tabs, and separators left stranded by a removal.
  cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\s*[|•·]\s*$/, '');
  cleaned = cleaned.replace(/^[\s:\-–—|]+/, '').trimEnd();

  return NO_CONTENT_REGEX.test(cleaned) ? cleaned : '';
}

/** Every non-promotional http(s) URL in the raw text, with its position. */
interface UrlOccurrence {
  url: string;
  index: number;
}

function collectApplyCandidates(text: string): UrlOccurrence[] {
  const candidates: UrlOccurrence[] = [];

  for (const match of text.matchAll(URL_REGEX)) {
    if (match.index === undefined) continue;

    const url = trimUrl(match[0]);
    if (!isApplyUrlCandidate(url) || isPromotionalUrl(url)) continue;

    candidates.push({ url, index: match.index });
  }

  return candidates;
}

/**
 * Scores how likely a URL is the post's application link, using only the text
 * around it: the label on its own line, the label on the line above, and the
 * shape of the URL itself.
 */
function scoreCandidate(text: string, occurrence: UrlOccurrence): number {
  const lineStart = text.lastIndexOf('\n', occurrence.index) + 1;
  const lineEndRaw = text.indexOf('\n', occurrence.index);
  const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
  const line = text.slice(lineStart, lineEnd);

  let score = 0;

  if (APPLY_CONTEXT_REGEX.test(line)) score += 3;
  if (APPLY_TARGET_REGEX.test(occurrence.url)) score += 2;

  // A label can also sit on its own line above the bare URL.
  const previousLines = text.slice(0, Math.max(lineStart - 1, 0)).split('\n');
  const previousLine = [...previousLines].reverse().find((entry) => entry.trim().length > 0);
  if (previousLine && APPLY_CONTEXT_REGEX.test(previousLine)) score += 1;

  return score;
}

/**
 * Picks the application URL out of the RAW message and returns it byte-for-byte.
 *
 * Reads the raw text on purpose: the URL must be the one the channel published,
 * not something reconstructed from cleaned text. When several links qualify the
 * best-labelled one wins; a lone non-promotional link is accepted as-is, because
 * discarding a real apply URL is the worse failure.
 */
export function extractApplyUrl(rawText: string): string | null {
  const candidates = collectApplyCandidates(rawText);
  if (candidates.length === 0) return null;

  let best = candidates[0]!;
  let bestScore = scoreCandidate(rawText, best);

  for (const candidate of candidates.slice(1)) {
    const score = scoreCandidate(rawText, candidate);
    // Strictly greater: on a tie the earlier link wins, which keeps the choice
    // stable for the same input.
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best.url;
}

/**
 * Normalizes one raw Telegram post.
 *
 * Never throws and never returns invented text: every character of
 * `cleanedText` comes from the input.
 */
export function normalizeMessage(rawText: string): NormalizedMessage {
  const raw = rawText ?? '';
  const removedUrls: string[] = [];
  const keptLines: string[] = [];
  let removedLines = 0;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0) {
      keptLines.push('');
      continue;
    }

    if (DIVIDER_LINE_REGEX.test(line)) {
      removedLines += 1;
      continue;
    }

    // A line holding a plausible application link is never dropped whole — the
    // promo parts are cut out of it instead.
    const holdsApplyLink = extractUrls(line).some(
      (url) => isApplyUrlCandidate(trimUrl(url)) && !isPromotionalUrl(trimUrl(url)),
    );

    if (!holdsApplyLink && isPromotionalLine(line)) {
      removedLines += 1;
      for (const url of extractUrls(line)) {
        if (isPromotionalUrl(trimUrl(url))) removedUrls.push(trimUrl(url));
      }
      continue;
    }

    const sanitized = sanitizeLine(line, removedUrls);

    if (sanitized.length === 0) {
      removedLines += 1;
      continue;
    }

    keptLines.push(sanitized);
  }

  const cleanedText = keptLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    cleanedText,
    // Extracted from the raw message so a promo-stripping edit can never alter
    // the URL a candidate is sent to.
    applyUrl: extractApplyUrl(raw),
    removedUrls: [...new Set(removedUrls)],
    removedLines,
  };
}
