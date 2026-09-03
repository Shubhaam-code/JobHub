/**
 * Repairing apply links on jobs that are already published.
 *
 * The engine behind `npm run jobs:fix-apply-urls`. The CLI owns argument parsing,
 * the cursor and the report file; this module owns the decision for one job and the
 * write, so both can be tested without a database or a network.
 *
 * Four properties this file is built around:
 *
 *  1. **Dry-run is the default.** `apply` must be passed explicitly. A caller that
 *     forgets gets a report and an untouched database.
 *  2. **Audit before write.** The audit row is inserted *before* `updateOne`, so a
 *     crash between the two leaves a recoverable record rather than a silent change.
 *     An audit insert that fails aborts the write for that row.
 *  3. **Idempotent.** A repaired job classifies `direct` and is skipped on the next
 *     run; a reviewed job is skipped by status. Re-running costs reads, not changes.
 *  4. **Never worse than before.** If the article cannot be read or no candidate is
 *     conclusive, the apply field is not touched — but its *status* becomes
 *     `needs_review`, and the aggregator URL moves to `sourceUrl` so nothing renders
 *     it as Apply Now.
 */

import { type Types } from 'mongoose';

import { logger } from '../lib/logger.js';
import {
  ApplyUrlAuditModel,
  type ApplyUrlAuditAction,
} from '../models/apply-url-audit.model.js';
import { updateApplyUrlFields } from '../models/job.repository.js';
import { extractApplyCandidates, pickConfidentCandidate } from './candidates.js';
import { classifyApplyUrl, hostOfUrl } from './classify.js';
import { fetchPageHtml } from './fetch-page.js';
import { classifyAndResolveApplyUrl } from './index.js';
import { type ApplyUrlCandidate, type ApplyUrlStatus } from './status.js';

/** The projection the backfill reads. Nothing else is needed to decide. */
export interface BackfillJob {
  _id: Types.ObjectId;
  applyUrl: string | null;
  applyUrlStatus?: ApplyUrlStatus | null;
  sourceUrl?: string | null;
  company?: string | null;
  telegramChannel?: string | null;
  telegramMessageId?: number | null;
  createdAt?: Date;
}

/** What happened to one job. `unchanged` and `skipped` never write. */
export type BackfillOutcome =
  | 'repaired'      // a direct link was found and stored
  | 'flagged'       // no conclusive link; status + sourceUrl updated, apply field untouched
  | 'unchanged'     // already fine, or already reviewed
  | 'skipped'       // outside the filter
  | 'error';

export interface BackfillRowResult {
  outcome: BackfillOutcome;
  oldUrl: string | null;
  newUrl: string | null;
  verdict: string;
  score: number | null;
  reason: string;
  candidates: ApplyUrlCandidate[] | null;
  /** Present on `repaired`/`flagged` when a write was actually issued. */
  written?: boolean;
}

export interface BackfillDeps {
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to the real audit insert + `$set`. */
  write?: (input: WriteInput) => Promise<boolean>;
}

export interface WriteInput {
  job: BackfillJob;
  runId: string;
  actor: string;
  action: ApplyUrlAuditAction;
  newUrl: string | null;
  newStatus: ApplyUrlStatus;
  newSourceUrl: string | null;
  candidates: ApplyUrlCandidate[] | null;
  verdict: string;
  score: number | null;
  reason: string;
}

/** A log label: Telegram coordinates when present, else the id. */
export function jobRef(job: BackfillJob): string {
  if (job.telegramChannel && typeof job.telegramMessageId === 'number') {
    return `[@${job.telegramChannel} msg ${String(job.telegramMessageId)}]`;
  }
  return `[job ${String(job._id)}]`;
}

/**
 * Records the change, then makes it.
 *
 * The order is the whole point: the audit row is what makes `--revert` possible, so
 * a write that is not preceded by one must not happen. If `updateOne` matches
 * nothing (the row changed under us), the audit row stays — an accurate record of an
 * attempt, and harmless to a revert, which matches on the stored URL.
 */
async function writeWithAudit(input: WriteInput): Promise<boolean> {
  await ApplyUrlAuditModel.create({
    postId: input.job._id,
    runId: input.runId,
    action: input.action,
    oldUrl: input.job.applyUrl ?? null,
    newUrl: input.newUrl,
    oldStatus: input.job.applyUrlStatus ?? null,
    newStatus: input.newStatus,
    oldSourceUrl: input.job.sourceUrl ?? null,
    verdict: input.verdict,
    score: input.score,
    reason: input.reason,
    actor: input.actor,
  });

  return updateApplyUrlFields(
    input.job._id,
    {
      applyUrl: input.newUrl,
      applyUrlStatus: input.newStatus,
      applyUrlCheckedAt: new Date(),
      sourceUrl: input.newSourceUrl,
      applyUrlCandidates: input.candidates,
    },
    // Optimistic guard: only write if the row still holds the URL we judged.
    input.job.applyUrl ?? null,
  );
}

export interface ProcessJobOptions {
  runId: string;
  actor: string;
  /** False (the default) reports without writing. */
  apply?: boolean;
}

/**
 * Decides and optionally applies the repair for one job.
 *
 * Never throws: an error is an `error` outcome with a reason, so one unreachable
 * aggregator cannot end a run partway through the collection.
 */
export async function processJob(
  job: BackfillJob,
  options: ProcessJobOptions,
  deps: BackfillDeps = {},
): Promise<BackfillRowResult> {
  const apply = options.apply ?? false;
  const write = deps.write ?? writeWithAudit;
  const oldUrl = job.applyUrl ?? null;

  const base = { oldUrl, newUrl: null, score: null, candidates: null } as const;

  try {
    // A row a human already ruled on is never re-decided by a script.
    if (job.applyUrlStatus === 'pending' || job.applyUrlStatus === 'verified') {
      const current = classifyApplyUrl(oldUrl, { company: job.company });
      // Unless the "verified" value is one this classifier rejects, which means it
      // predates the classifier and its status cannot be trusted.
      if (current.verdict === 'direct' || job.applyUrlStatus === 'pending') {
        return {
          ...base,
          outcome: 'unchanged',
          verdict: current.verdict,
          reason: `already ${job.applyUrlStatus}`,
        };
      }
    }

    const first = await classifyAndResolveApplyUrl(oldUrl, {
      company: job.company,
      fetchImpl: deps.fetchImpl,
    });

    // Already a real destination. Stamp the status if it is missing, but never
    // touch the URL — there is nothing to improve.
    if (first.verdict === 'direct') {
      if (job.applyUrlStatus === 'verified' && first.normalizedUrl === oldUrl) {
        return { ...base, outcome: 'unchanged', verdict: 'direct', reason: first.reason };
      }

      const written = apply
        ? await write({
            job,
            runId: options.runId,
            actor: options.actor,
            action: 'backfill',
            newUrl: first.normalizedUrl,
            newStatus: 'verified',
            newSourceUrl: job.sourceUrl ?? null,
            candidates: null,
            verdict: 'direct',
            score: null,
            reason: first.reason,
          })
        : false;

      return {
        ...base,
        outcome: 'repaired',
        newUrl: first.normalizedUrl,
        verdict: 'direct',
        reason: first.reason,
        written,
      };
    }

    // No URL at all: `pending` is the honest state, and nothing is invented.
    if (first.verdict === 'unresolvable' && first.normalizedUrl === null) {
      const written = apply
        ? await write({
            job,
            runId: options.runId,
            actor: options.actor,
            action: 'backfill_review',
            newUrl: null,
            newStatus: oldUrl === null ? 'pending' : 'needs_review',
            newSourceUrl: job.sourceUrl ?? null,
            candidates: null,
            verdict: 'unresolvable',
            score: null,
            reason: first.reason,
          })
        : false;

      return {
        ...base,
        outcome: 'flagged',
        verdict: 'unresolvable',
        reason: first.reason,
        written,
      };
    }

    const pageUrl = first.normalizedUrl;

    // ── An aggregator article: open it and look for the real apply link. ──
    let candidates: ApplyUrlCandidate[] = [];
    let winner: ApplyUrlCandidate | null = null;
    let pageReason = first.reason;

    if (first.verdict === 'aggregator' && pageUrl !== null) {
      const page = await fetchPageHtml(pageUrl, { fetchImpl: deps.fetchImpl });

      if (page.ok) {
        candidates = extractApplyCandidates(page.html, pageUrl, { company: job.company });
        winner = pickConfidentCandidate(candidates);
        pageReason =
          candidates.length === 0
            ? 'aggregator page had no apply candidate'
            : `${String(candidates.length)} candidate(s) on the page`;
      } else {
        pageReason = `aggregator page unreadable (${page.reason})`;
      }
    }

    // A conclusive candidate, re-judged on its own terms before it is stored.
    if (winner !== null) {
      const verdict = classifyApplyUrl(winner.url, { company: job.company });

      if (verdict.verdict === 'direct') {
        const written = apply
          ? await write({
              job,
              runId: options.runId,
              actor: options.actor,
              action: 'backfill',
              newUrl: verdict.normalizedUrl,
              newStatus: 'verified',
              // The article is provenance from here on, never a destination.
              newSourceUrl: pageUrl,
              candidates: candidates.length > 1 ? candidates : null,
              verdict: 'direct',
              score: winner.score,
              reason: winner.reason,
            })
          : false;

        return {
          outcome: 'repaired',
          oldUrl,
          newUrl: verdict.normalizedUrl,
          verdict: 'direct',
          score: winner.score,
          reason: `${winner.reason} (${winner.confidence})`,
          candidates: candidates.length > 1 ? candidates : null,
          written,
        };
      }

      pageReason = `best candidate is ${verdict.verdict} (${verdict.reason})`;
      winner = null;
    }

    /* Nothing conclusive. The apply field is emptied rather than left holding an
       aggregator URL — that is the defect being fixed — and the URL is preserved in
       `sourceUrl`, which is never rendered as Apply Now. A `suspicious` link is
       different: it may well be fine, so it stays in place and only gains a status,
       because clearing a working link would be its own kind of damage. */
    const isAggregator = first.verdict === 'aggregator';

    const written = apply
      ? await write({
          job,
          runId: options.runId,
          actor: options.actor,
          action: 'backfill_review',
          newUrl: isAggregator ? null : oldUrl,
          newStatus: 'needs_review',
          newSourceUrl: isAggregator ? pageUrl : (job.sourceUrl ?? null),
          candidates: candidates.length > 0 ? candidates : null,
          verdict: first.verdict,
          score: null,
          reason: pageReason,
        })
      : false;

    return {
      outcome: 'flagged',
      oldUrl,
      newUrl: isAggregator ? null : oldUrl,
      verdict: first.verdict,
      score: null,
      reason: pageReason,
      candidates: candidates.length > 0 ? candidates : null,
      written,
    };
  } catch (error: unknown) {
    return {
      ...base,
      outcome: 'error',
      verdict: 'error',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Undoes every write from one run.
 *
 * Walks the run's audit rows newest-first, so a job touched twice ends at the value
 * it held before the run rather than in the middle of it. Each restore is itself
 * audited — a revert is a write, and the same rule applies to it.
 *
 * The `newUrl` is matched in the update filter, so a job changed *after* the run
 * (by a human in the review queue, say) is reported as a conflict and left alone
 * instead of being rolled back over someone's decision.
 */
export async function revertRun(
  runId: string,
  options: { actor: string; apply?: boolean },
): Promise<{ examined: number; reverted: number; conflicts: number }> {
  const apply = options.apply ?? false;
  const rows = await ApplyUrlAuditModel.find({ runId, action: { $ne: 'revert' } })
    .sort({ createdAt: -1 })
    .lean();

  let reverted = 0;
  let conflicts = 0;

  for (const row of rows) {
    if (!apply) {
      logger.info(
        `[revert] would restore ${String(row.postId)} → ${row.oldUrl ?? '(empty)'} (was ${
          row.newUrl ?? '(empty)'
        })`,
      );
      reverted += 1;
      continue;
    }

    const restored = await updateApplyUrlFields(
      row.postId,
      {
        applyUrl: row.oldUrl,
        applyUrlStatus: row.oldStatus ?? undefined,
        sourceUrl: row.oldSourceUrl,
        applyUrlCandidates: null,
        applyUrlCheckedAt: new Date(),
      },
      row.newUrl,
    );

    if (!restored) {
      conflicts += 1;
      logger.warn(
        `[revert] ${String(row.postId)} changed since the run — left alone (expected ${
          row.newUrl ?? '(empty)'
        })`,
      );
      continue;
    }

    await ApplyUrlAuditModel.create({
      postId: row.postId,
      runId: `revert-of-${runId}`,
      action: 'revert',
      oldUrl: row.newUrl,
      newUrl: row.oldUrl,
      oldStatus: row.newStatus,
      newStatus: row.oldStatus,
      oldSourceUrl: row.oldSourceUrl,
      verdict: 'revert',
      score: null,
      reason: `reverting ${runId}`,
      actor: options.actor,
    });

    reverted += 1;
  }

  return { examined: rows.length, reverted, conflicts };
}

/** Host of a URL for the per-host delay, or `''` when there is none. */
export function delayKeyFor(url: string | null): string {
  return url === null ? '' : (hostOfUrl(url) ?? '');
}
