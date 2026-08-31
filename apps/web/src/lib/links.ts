/**
 * Link handling for values that came out of Telegram posts.
 *
 * Nothing here invents or rewrites a destination: an email becomes `mailto:`,
 * an http(s) URL is used verbatim, a bare `www.` host only gains the scheme it
 * needs to be a working href. Anything else is treated as plain text so a
 * hostile `javascript:` payload can never reach an `href`.
 */

/** Matches http(s) URLs, bare `www.` hosts, and email addresses, in that order. */
const TOKEN_PATTERN =
  /(https?:\/\/[^\s<>()[\]{}"'`]+|www\.[^\s<>()[\]{}"'`]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** Sentence punctuation that sits after a link rather than inside it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"“”’]+$/;

export type LinkKind = "url" | "email";

export interface ResolvedLink {
  kind: LinkKind;
  /** The value exactly as it appeared in the source text. */
  text: string;
  /** Safe href: `mailto:` for emails, an absolute http(s) URL otherwise. */
  href: string;
}

/**
 * Turns a stored value into a safe href, or null when it is neither an email
 * nor an http(s) URL.
 */
export function resolveLink(value: string | null | undefined): ResolvedLink | null {
  const text = value?.trim();
  if (!text) return null;

  if (EMAIL_PATTERN.test(text)) {
    return { kind: "email", text, href: `mailto:${text}` };
  }

  const candidate = /^www\./i.test(text) ? `https://${text}` : text;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { kind: "url", text, href: candidate };
  } catch {
    return null;
  }
}

export type TextSegment = { type: "text"; text: string };
export type LinkSegment = ResolvedLink & { type: "link" };
export type LinkifiedSegment = TextSegment | LinkSegment;

/**
 * Splits text into plain and link segments, preserving every character —
 * including line breaks — so the original post can be rendered verbatim.
 */
export function linkifyText(text: string): LinkifiedSegment[] {
  if (!text) return [];

  const segments: LinkifiedSegment[] = [];
  let cursor = 0;

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const raw = match[0];
    const start = match.index;
    if (start === undefined) continue;

    // Punctuation that closes a sentence belongs to the text, not the link.
    const trimmed = raw.replace(TRAILING_PUNCTUATION, "");
    const link = trimmed ? resolveLink(trimmed) : null;
    if (!link) continue;

    if (start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, start) });
    }
    segments.push({ type: "link", ...link });
    cursor = start + trimmed.length;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }

  return segments;
}
