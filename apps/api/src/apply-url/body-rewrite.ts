/**
 * Rewriting aggregator links that live *inside* a job description.
 *
 * A separate pass from the apply-field repair, and deliberately more cautious,
 * because the risk profile is different: the apply field holds one URL that can be
 * cleared and re-derived, while a description is prose a user reads. A bad edit here
 * corrupts content rather than emptying a field.
 *
 * Three rules keep that risk contained:
 *
 *  1. **Only the `href` changes.** The replacement is spliced into the exact byte
 *     range of the old URL, so anchor text, attributes, whitespace and every other
 *     character of the body are byte-identical afterwards. Nothing is re-serialized.
 *  2. **Only where the destination is already known.** A body URL is rewritten only
 *     when the *same* URL was resolved to a direct link during the apply-field pass
 *     (recorded in the audit trail) or resolves to one now with a single conclusive
 *     candidate. There is no separate, looser judgement here.
 *  3. **Anything else is flagged, not touched.** An unreadable page, an ambiguous
 *     candidate set, or a URL appearing under text that is not an apply CTA leaves
 *     the body exactly as it is and marks the job for review.
 *
 * The full previous body is written to the audit row before the update, because a
 * rewritten description cannot be reconstructed from a URL pair — that copy is the
 * only way back.
 */

import { type Types } from 'mongoose';

import { logger } from '../lib/logger.js';
import { JobModel } from '../models/job.model.js';
import { ApplyUrlAuditModel } from '../models/apply-url-audit.model.js';
import { extractApplyCandidates, pickConfidentCandidate } from './candidates.js';
import { classifyApplyUrl } from './classify.js';
import { fetchPageHtml } from './fetch-page.js';

/** URLs as they appear in body text, with their exact byte offsets. */
const BODY_URL_REGEX = /https?:\/\/[^\s<>"'`)\]}]+/gi;

/** Trailing punctuation that belongs to the sentence, not the URL. */
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?]+$/;

/**
 * Text around a link that marks it as the application CTA.
 *
 * Required for a rewrite: an aggregator URL mentioned in passing ("posted on
 * freshershunt") is not a call to action and is left alone.
 */
const APPLY_CTA_REGEX =
  /\b(?:apply|application|register|registration|click\s+here|direct\s+link|job\s+link|official\s+link)\b/i;

/** How much text either side of a URL counts as "nearby" for the CTA check. */
const CONTEXT_WINDOW = 120;

export interface BodyRewriteOptions {
  runId: string;
  actor: string;
  /** False (the default) reports without writing. */
  apply?: boolean;
  fetchImpl?: typeof fetch;
  /** Stop after this many jobs. 0 means no limit. */
  limit?: number;
}

export interface BodyRewriteSummary {
  examined: number;
  rewritten: number;
  flagged: number;
  unchanged: number;
  errors: number;
}

interface BodyMatch {
  /** The URL as it appears in the body, punctuation trimmed. */
  raw: string;
  start: number;
  end: number;
}

/** Every http(s) URL in the body, with the offsets needed to splice it. */
export function findBodyUrls(body: string): BodyMatch[] {
  const matches: BodyMatch[] = [];

  for (const match of body.matchAll(BODY_URL_REGEX)) {
    const index = match.index;
    if (index === undefined) continue;

    const raw = match[0].replace(TRAILING_PUNCTUATION_REGEX, '');
    if (raw.length === 0) continue;

    matches.push({ raw, start: index, end: index + raw.length });
  }

  return matches;
}

/** True when the text around `[start, end)` reads as an apply call to action. */
export function hasApplyContext(body: string, start: number, end: number): boolean {
  const before = body.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  const after = body.slice(end, end + CONTEXT_WINDOW);
  return APPLY_CTA_REGEX.test(before) || APPLY_CTA_REGEX.test(after);
}

/**
 * Applies a set of replacements to a body without disturbing anything else.
 *
 * Splices run back-to-front so an earlier replacement cannot shift a later offset.
 */
export function spliceBody(
  body: string,
  replacements: readonly { start: number; end: number; url: string }[],
): string {
  let result = body;

  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.url + result.slice(replacement.end);
  }

  return result;
}

/**
 * Resolves one aggregator body URL to a direct link, or null.
 *
 * Deliberately the same strictness as the apply-field pass: one conclusive
 * candidate, re-classified as `direct` on its own terms, or nothing.
 */
async function resolveBodyUrl(
  url: string,
  company: string | null | undefined,
  fetchImpl?: typeof fetch,
): Promise<{ url: string; reason: string } | null> {
  const page = await fetchPageHtml(url, { fetchImpl });
  if (!page.ok) return null;

  const winner = pickConfidentCandidate(extractApplyCandidates(page.html, url, { company }));
  if (winner === null) return null;

  const verdict = classifyApplyUrl(winner.url, { company });
  if (verdict.verdict !== 'direct' || verdict.normalizedUrl === null) return null;

  return { url: verdict.normalizedUrl, reason: winner.reason };
}

/**
 * Rewrites aggregator links inside descriptions across the collection.
 *
 * Streams a cursor, and only looks at jobs whose body actually contains one of the
 * known aggregator hosts — the `$regex` filter keeps the scan off the 400-odd rows
 * that have nothing to rewrite.
 */
export async function rewriteBodies(options: BodyRewriteOptions): Promise<BodyRewriteSummary> {
  const apply = options.apply ?? false;
  const limit = options.limit ?? 0;

  const summary: BodyRewriteSummary = {
    examined: 0,
    rewritten: 0,
    flagged: 0,
    unchanged: 0,
    errors: 0,
  };

  const cursor = JobModel.find({ cleanedText: { $ne: null } })
    .select({ cleanedText: 1, company: 1, telegramChannel: 1, telegramMessageId: 1 })
    .lean()
    .cursor();

  try {
    for (;;) {
      const document = await cursor.next();
      if (document === null || document === undefined) break;

      const job = document as unknown as {
        _id: Types.ObjectId;
        cleanedText: string | null;
        company?: string | null;
      };

      const body = job.cleanedText;
      if (body === null || body.length === 0) continue;

      const urls = findBodyUrls(body);
      const aggregators = urls.filter(
        (match) => classifyApplyUrl(match.raw).verdict === 'aggregator',
      );

      if (aggregators.length === 0) continue;

      summary.examined += 1;
      if (limit > 0 && summary.examined > limit) break;

      try {
        const replacements: { start: number; end: number; url: string }[] = [];
        /** Resolved once per distinct URL — a body often repeats the same link. */
        const resolvedByUrl = new Map<string, { url: string; reason: string } | null>();
        let skipped = 0;

        for (const match of aggregators) {
          // Not a CTA: a mention, not a link to send someone to. Left as it is.
          if (!hasApplyContext(body, match.start, match.end)) {
            skipped += 1;
            continue;
          }

          const normalized = classifyApplyUrl(match.raw).normalizedUrl ?? match.raw;

          if (!resolvedByUrl.has(normalized)) {
            resolvedByUrl.set(
              normalized,
              await resolveBodyUrl(normalized, job.company, options.fetchImpl),
            );
          }

          const resolved = resolvedByUrl.get(normalized) ?? null;
          if (resolved === null) {
            skipped += 1;
            continue;
          }

          replacements.push({ start: match.start, end: match.end, url: resolved.url });
        }

        if (replacements.length === 0) {
          summary.flagged += 1;
          if (apply) {
            // The body is untouched; only the review flag is recorded, so a human
            // sees that this description still carries aggregator links.
            await JobModel.updateOne(
              { _id: job._id },
              { $set: { applyUrlStatus: 'needs_review', applyUrlCheckedAt: new Date() } },
            );
          }
          continue;
        }

        const rewritten = spliceBody(body, replacements);

        if (rewritten === body) {
          summary.unchanged += 1;
          continue;
        }

        if (!apply) {
          summary.rewritten += 1;
          logger.info(
            `[body ${String(job._id)}] would rewrite ${String(replacements.length)} href(s)${
              skipped > 0 ? `, ${String(skipped)} left alone` : ''
            }`,
          );
          continue;
        }

        // The full previous body first: a rewritten description cannot be
        // reconstructed from a URL pair, so this copy is the only way back.
        await ApplyUrlAuditModel.create({
          postId: job._id,
          runId: options.runId,
          action: 'body_rewrite',
          oldUrl: aggregators.map((match) => match.raw).join(' | '),
          newUrl: replacements.map((replacement) => replacement.url).join(' | '),
          verdict: 'body_rewrite',
          reason: `${String(replacements.length)} href(s) rewritten, ${String(skipped)} left alone`,
          actor: options.actor,
          oldBody: body,
        });

        // `updateOne`/`$set` rather than `save()`, so the `pre('save')` hook does
        // not re-stamp `expiresAt` and change which jobs the feed shows.
        await JobModel.updateOne({ _id: job._id }, { $set: { cleanedText: rewritten } });

        summary.rewritten += 1;
        logger.info(
          `[body ${String(job._id)}] rewrote ${String(replacements.length)} href(s)${
            skipped > 0 ? `, ${String(skipped)} left alone` : ''
          }`,
        );
      } catch (error: unknown) {
        summary.errors += 1;
        logger.error(
          `[body ${String(job._id)}] failed → ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  } finally {
    await cursor.close();
  }

  return summary;
}
