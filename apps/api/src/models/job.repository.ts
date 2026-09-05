/**
 * The only way a job is written.
 *
 * Before this existed, three paths could set `applyUrl` — the queue worker, the
 * cleanup script and the URL backfill — each with its own idea of what a valid
 * link was. Consolidating them here is what makes "an aggregator URL can never be
 * stored" a property of the system rather than a property of whichever caller
 * remembered to check.
 *
 * The rule this file enforces, in one sentence: **the apply field either holds a
 * link classified `direct`, or it holds nothing.** Everything else — an aggregator
 * article, an unresolved shortener, a link we cannot judge — either goes into
 * `sourceUrl` as provenance or is recorded as a candidate for a human, and the
 * apply field is left empty with an honest status. Nothing is ever invented to
 * fill the gap.
 */

import { logger } from '../lib/logger.js';
import { classifyApplyUrl, type ApplyUrlClassification } from '../apply-url/classify.js';
import { type ApplyUrlCandidate, type ApplyUrlStatus } from '../apply-url/status.js';
import { JobModel, type JobDocument } from './job.model.js';

/** The extracted and provenance fields a caller supplies for a new job. */
export interface SaveJobInput {
  company: string | null;
  role: string | null;
  batch: string | null;
  /** The link as extracted. May be anything — it is classified here, not trusted. */
  applyUrl: string | null;
  location: string | null;
  employmentType: string | null;
  companyLogoUrl?: string | null;
  /** The page the apply link was found on, when it was not the application itself. */
  sourceUrl?: string | null;
  /** Candidates for the review queue, when the choice was not obvious. */
  applyUrlCandidates?: ApplyUrlCandidate[] | null;
  source: string;
  /** Stable identity for sources that are not Telegram channels. */
  sourceId?: string | null;
  telegramChannel: string;
  telegramChannelId: string | null;
  telegramMessageId: number;
  telegramMessageUrl: string | null;
  originalText: string;
  cleanedText: string | null;
  postedAt: Date;
}

/** What `resolveApplyUrlFields` decided, and why. */
export interface ApplyUrlDecision {
  applyUrl: string | null;
  applyUrlStatus: ApplyUrlStatus;
  sourceUrl: string | null;
  applyUrlCandidates: ApplyUrlCandidate[] | null;
  applyUrlCheckedAt: Date;
  /** The classification behind the decision, for logging. */
  classification: ApplyUrlClassification;
}

/**
 * Turns an extracted link into the four fields that get stored.
 *
 * Pure and synchronous, and exported so the queue worker, the backfill and the
 * admin queue all derive those fields the same way — and so this decision can be
 * unit tested without a database.
 *
 * The mapping from verdict to stored state:
 *
 *   direct       → stored in `applyUrl`, `verified`
 *   aggregator   → `applyUrl` empty, the URL moved to `sourceUrl`, `needs_review`
 *   wrapper      → `applyUrl` empty, kept as a candidate, `needs_review`
 *   suspicious   → `applyUrl` empty, kept as a candidate, `needs_review`
 *   unresolvable → `applyUrl` empty, `pending` when there was no URL at all
 *
 * Note what does *not* happen for `aggregator`: the URL is not deleted (it is real
 * provenance and the only lead a human has) and it is not left in the apply field
 * (it is a competitor's page). Moving it to `sourceUrl` is what satisfies both.
 */
export function resolveApplyUrlFields(
  rawApplyUrl: string | null | undefined,
  options: { company?: string | null; sourceUrl?: string | null } = {},
): ApplyUrlDecision {
  const classification = classifyApplyUrl(rawApplyUrl, { company: options.company });
  const checkedAt = new Date();
  const providedSource = options.sourceUrl?.trim() || null;

  if (classification.verdict === 'direct') {
    return {
      applyUrl: classification.normalizedUrl,
      applyUrlStatus: 'verified',
      sourceUrl: providedSource,
      applyUrlCandidates: null,
      applyUrlCheckedAt: checkedAt,
      classification,
    };
  }

  if (classification.verdict === 'aggregator') {
    return {
      applyUrl: null,
      applyUrlStatus: 'needs_review',
      // Provenance, never a destination. This is the page a human opens to find
      // the real link, which is exactly what the review queue offers them.
      sourceUrl: classification.normalizedUrl ?? providedSource,
      applyUrlCandidates: null,
      applyUrlCheckedAt: checkedAt,
      classification,
    };
  }

  if (classification.verdict === 'unresolvable') {
    return {
      applyUrl: null,
      // No link at all is `pending` — registration may simply not be open yet.
      // A malformed one is a real defect and gets a human's attention.
      applyUrlStatus: classification.reason === 'no URL' ? 'pending' : 'needs_review',
      sourceUrl: providedSource,
      applyUrlCandidates: null,
      applyUrlCheckedAt: checkedAt,
      classification,
    };
  }

  // `wrapper` and `suspicious`: we have something, but not something to send a
  // user to. It is offered to the reviewer as a candidate rather than stored.
  return {
    applyUrl: null,
    applyUrlStatus: 'needs_review',
    sourceUrl: providedSource,
    applyUrlCandidates:
      classification.normalizedUrl === null
        ? null
        : [
            {
              url: classification.normalizedUrl,
              finalUrl: classification.finalUrl ?? null,
              confidence: 'low',
              score: 0,
              reason: classification.reason,
              label: null,
            },
          ],
    applyUrlCheckedAt: checkedAt,
    classification,
  };
}

/**
 * Creates a job, with its apply link classified on the way in.
 *
 * The single write path. A caller cannot opt out of classification, because the
 * apply fields are computed here from `input.applyUrl` rather than copied from it.
 *
 * After creating the job, if the apply URL was not verified, this automatically
 * triggers background discovery via the apply-discovery queue.
 *
 * Throws whatever Mongoose throws — including the duplicate-key error the queue
 * worker already handles as success, which is deliberately not swallowed here.
 */
export async function saveJob(input: SaveJobInput): Promise<JobDocument> {
  const decision = resolveApplyUrlFields(input.applyUrl, {
    company: input.company,
    sourceUrl: input.sourceUrl,
  });

  const ref = `[@${input.telegramChannel} msg ${String(input.telegramMessageId)}]`;

  if (decision.applyUrlStatus !== 'verified') {
    logger.warn(
      `${ref} apply link not stored → ${decision.classification.verdict}: ${decision.classification.reason}`,
    );
  }

  const created = await JobModel.create({
    company: input.company,
    role: input.role,
    batch: input.batch,
    location: input.location,
    employmentType: input.employmentType,
    companyLogoUrl: input.companyLogoUrl ?? null,

    applyUrl: decision.applyUrl,
    applyUrlStatus: decision.applyUrlStatus,
    applyUrlCheckedAt: decision.applyUrlCheckedAt,
    /* The UI gates the Apply button on this flag, not on `applyUrlStatus`. It has
       to be set here as well: a link the classifier judged `direct` at ingest is
       verified, and leaving it on the schema default of `false` hid the Apply
       button on every correctly-ingested job. */
    applyUrlVerified: decision.applyUrlStatus === 'verified',
    applyUrlDiscoveryMethod: decision.applyUrlStatus === 'verified' ? 'direct_extraction' : null,
    sourceUrl: decision.sourceUrl,
    // A caller that already did the candidate work (the resolver) wins; otherwise
    // the classification's own single candidate is kept.
    applyUrlCandidates: input.applyUrlCandidates ?? decision.applyUrlCandidates,

    source: input.source,
    sourceId: input.sourceId ?? undefined,
    telegramChannel: input.telegramChannel,
    telegramChannelId: input.telegramChannelId,
    telegramMessageId: input.telegramMessageId,
    telegramMessageUrl: input.telegramMessageUrl,
    originalText: input.originalText,
    cleanedText: input.cleanedText,
    postedAt: input.postedAt,
  });

  // Trigger background apply URL discovery if not already verified.
  // This runs async and never blocks the save path.
  if (decision.applyUrlStatus !== 'verified') {
    triggerApplyDiscovery(created, input, decision).catch((error: unknown) => {
      // Log but never throw - discovery failure must not break job creation.
      logger.error(`${ref} failed to enqueue apply discovery: ${errorText(error)}`);
    });
  }

  return created;
}

/**
 * Enqueues the job for background apply URL discovery.
 *
 * Fire-and-forget: errors are logged but never thrown, so discovery failure
 * never breaks the job creation flow.
 */
async function triggerApplyDiscovery(
  job: JobDocument,
  input: SaveJobInput,
  decision: ApplyUrlDecision,
): Promise<void> {
  const { env } = await import('../config/env.js');

  // Skip if discovery is disabled.
  if (!env.APPLY_DISCOVERY_ENABLED) return;

  const { enqueueDiscoveryJob } = await import('../apply-discovery/queue.js');

  await enqueueDiscoveryJob({
    jobId: job._id.toString(),
    company: input.company,
    role: input.role,
    location: input.location,
    employmentType: input.employmentType,
    batch: input.batch,
    sourceUrl: decision.sourceUrl,
    initialApplyUrl: input.applyUrl,
    initialCandidates: input.applyUrlCandidates ?? decision.applyUrlCandidates,
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Fields the apply-link paths are allowed to write on an existing job. */
export interface UpdateApplyUrlFields {
  applyUrl?: string | null;
  applyUrlStatus?: ApplyUrlStatus;
  applyUrlCheckedAt?: Date | null;
  sourceUrl?: string | null;
  applyUrlCandidates?: ApplyUrlCandidate[] | null;
  /** Whether the link was proven to be this posting's application. Gates the UI. */
  applyUrlVerified?: boolean;
  /** Which discovery stage produced the link. */
  applyUrlDiscoveryMethod?: string | null;
  /** The evidence behind `applyUrlVerified`, for the admin queue. */
  applyUrlVerificationEvidence?: unknown;
}

/**
 * Writes the apply-link fields on one existing job, and nothing else.
 *
 * `updateOne` with `$set` rather than `save()`, on purpose: `save()` would run the
 * model's `pre('save')` hook and re-stamp `expiresAt`, so repairing a link would
 * silently change which jobs the feed shows.
 *
 * `expectedApplyUrl` is matched in the filter as well as the id, so a row that
 * changed between the read and the write is left alone instead of being overwritten
 * from a stale read. Returns whether a row was actually modified.
 *
 * A `applyUrl` being set here is classified first: `$set` bypasses the schema
 * validator, so this is where that guard is applied for the update path.
 */
export async function updateApplyUrlFields(
  id: unknown,
  fields: UpdateApplyUrlFields,
  expectedApplyUrl?: string | null,
): Promise<boolean> {
  if (fields.applyUrl !== undefined && fields.applyUrl !== null) {
    const verdict = classifyApplyUrl(fields.applyUrl).verdict;
    if (verdict === 'aggregator') {
      throw new Error(
        `refusing to store an aggregator URL as an apply link: ${fields.applyUrl}`,
      );
    }
  }

  const filter: Record<string, unknown> = { _id: id };
  if (expectedApplyUrl !== undefined) filter['applyUrl'] = expectedApplyUrl;

  const result = await JobModel.updateOne(filter, { $set: fields });

  return result.modifiedCount > 0;
}
