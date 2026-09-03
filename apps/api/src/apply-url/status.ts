/**
 * The lifecycle of a stored apply link.
 *
 * Separate from the classifier's *verdict*, and the distinction is the point. A
 * verdict is a judgement about a URL, recomputable at any moment from the URL
 * itself. A status is a fact about a row: what we decided, who decided it, and
 * whether a human still needs to look.
 *
 *   verified     — classified `direct`, stored, and safe to render as Apply Now.
 *   needs_review — we have candidates or a doubt, and a human must choose. The
 *                  apply field is left exactly as it was; nothing is guessed.
 *   pending      — there is genuinely no application URL yet (registration not
 *                  open). An empty apply field is the correct, honest state.
 *   broken       — the link was verified once and no longer answers (404/410/
 *                  timeout), or it now redirects into an aggregator.
 *
 * A row with no status at all — every row stored before this field existed — reads
 * as `needs_review` at the boundaries that care, so a legacy row is never treated
 * as if someone had verified it.
 */

export const APPLY_URL_STATUSES = ['verified', 'needs_review', 'pending', 'broken'] as const;

export type ApplyUrlStatus = (typeof APPLY_URL_STATUSES)[number];

/** One candidate link found on a source page, with the reasoning that scored it. */
export interface ApplyUrlCandidate {
  /** The normalized candidate URL. */
  url: string;
  /** Final URL after redirects, when it was resolved. */
  finalUrl?: string | null;
  /** Confidence bucket — see `scoreCandidate` in `candidates.ts`. */
  confidence: 'highest' | 'high' | 'medium' | 'low' | 'reject';
  /** Numeric score behind the bucket, for stable ordering. */
  score: number;
  /** Why it scored the way it did. Shown verbatim in the review queue. */
  reason: string;
  /** The anchor text it was found under, when there was one. */
  label?: string | null;
}
