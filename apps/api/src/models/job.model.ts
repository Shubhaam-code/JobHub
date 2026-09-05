import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

import { classifyApplyUrl } from '../apply-url/classify.js';
import { APPLY_URL_STATUSES } from '../apply-url/status.js';
import { env } from '../config/env.js';

/**
 * How long a listing stays in the public feed.
 *
 * A posting is only useful while it is plausibly still open, so every stored job
 * carries an `expiresAt` 21 days after it was created. Nothing is deleted when
 * that moment passes — the document stays for admin, history and analytics, and
 * only drops out of the user-facing queries (see `activeJobClauses`).
 */
export const JOB_ACTIVE_WINDOW_DAYS = 21;
export const JOB_ACTIVE_WINDOW_MS = JOB_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Public-feed window measured from the source's posted date.
 *
 * `JOB_ACTIVE_WINDOW_DAYS` remains the legacy lifecycle/expiry value used by
 * existing records and admin tooling. Public visibility is stricter and is
 * based on `postedAt`, never on when the document happened to be imported.
 */
export const JOB_SOURCE_ACTIVE_WINDOW_DAYS = 15;
export const JOB_SOURCE_ACTIVE_WINDOW_MS = JOB_SOURCE_ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Lifecycle states.
 *
 * `expired` and `closed` both hide a listing immediately, whatever its
 * `expiresAt` says: `closed` is a source that told us the role is filled or the
 * deadline has passed, `expired` is a listing retired ahead of its window.
 */
export const JOB_STATUSES = ['active', 'expired', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_ACTIVE: JobStatus = 'active';

/** The end of the 21-day window for a listing created at `createdAt`. */
export function jobExpiryFrom(createdAt: Date): Date {
  return new Date(createdAt.getTime() + JOB_ACTIVE_WINDOW_MS);
}

/**
 * Job / internship opportunity ingested from a Telegram channel.
 *
 * Primary extracted fields are nullable — extraction never invents data.
 * Provenance fields are required so every document can be traced to its source.
 */
const jobSchema = new Schema(
  {
    // ── Primary extracted fields ──────────────────────────────────────────
    company: { type: String, default: null },
    role: { type: String, default: null },
    batch: { type: String, default: null },
    applyUrl: { type: String, default: null },
    location: { type: String, default: null },
    employmentType: { type: String, default: null },
    /**
     * The company's logo, resolved from `company` during ingestion.
     *
     * Nullable like every other extracted field, and for the same reason: it is
     * only set when a real logo was verified for the name. Null — and a legacy
     * row with no such field at all — means the UI draws its monogram, which is
     * what every card did before this field existed.
     */
    companyLogoUrl: { type: String, default: null },

    // ── Apply-link integrity ──────────────────────────────────────────────
    /**
     * The page the link was found on, when it was not the application itself —
     * an aggregator article we resolved through.
     *
     * Kept because it is useful provenance (it is how a human checks a resolved
     * link), and kept *here* rather than in `applyUrl` because it is never a
     * destination we send a user to. Nothing renders this field.
     */
    sourceUrl: { type: String, default: null },
    /**
     * Where `applyUrl` stands: `verified`, `needs_review`, `pending`, `broken`.
     *
     * Null — and a legacy row with no such field — reads as `needs_review` at
     * every boundary that cares, so a row stored before this existed is never
     * mistaken for one a human verified. See `src/apply-url/status.ts`.
     */
    applyUrlStatus: { type: String, enum: APPLY_URL_STATUSES, default: null },
    /** When the link was last classified or health-checked. */
    applyUrlCheckedAt: { type: Date, default: null },
    /**
     * Candidate apply links found on the source page, with their scores and
     * reasons, for the admin review queue.
     *
     * Populated only when the choice was *not* obvious — exactly one
     * high-confidence candidate is applied directly instead. `Mixed` because the
     * shape is a report for a human, not something queried on.
     */
    applyUrlCandidates: { type: Schema.Types.Mixed, default: null },

    // ── Universal Apply Discovery ─────────────────────────────────────────
    /**
     * Whether the apply URL was verified by the universal discovery agent.
     * true = verified with strong evidence, false = not verified or pending.
     */
    applyUrlVerified: { type: Boolean, default: false },
    /**
     * Discovery method used to find the apply URL.
     * One of: direct_extraction, firecrawl_scrape, web_search, company_search, none
     */
    applyUrlDiscoveryMethod: { type: String, default: null },
    /**
     * Evidence collected during URL validation.
     * Contains: companyMatch, roleMatch, locationMatch, hasApplicationAction,
     * isOfficialSource, overallConfidence, and detailed signals.
     */
    applyUrlVerificationEvidence: { type: Schema.Types.Mixed, default: null },

    // ── Provenance ────────────────────────────────────────────────────────
    source: { type: String, required: true, trim: true },
    /** Stable identity supplied by non-Telegram sources (for example GitHub). */
    sourceId: { type: String, trim: true, default: undefined },
    telegramChannel: { type: String, required: true, trim: true },
    /** Numeric Telegram channel ID as a string. Survives a username change. */
    telegramChannelId: { type: String, default: null },
    telegramMessageId: { type: Number, required: true },
    telegramMessageUrl: { type: String, default: null },
    /**
     * Raw post, retained for debugging and for grounding checks.
     * Never rendered to users — the UI reads `cleanedText`.
     */
    originalText: { type: String, required: true },
    /** Post with channel promotion stripped out. This is what users read. */
    cleanedText: { type: String, default: null },
    postedAt: { type: Date, required: true },

    // ── Lifecycle ─────────────────────────────────────────────────────────
    /**
     * Whether the listing may still be shown to users. Defaults to `active`;
     * rows stored before this field existed have no value at all, which the
     * user-facing filter reads as active.
     */
    status: { type: String, enum: JOB_STATUSES, default: JOB_STATUS_ACTIVE },
    /**
     * GitHub feed visibility is kept separately from the legacy lifecycle status.
     * This lets the dedicated feed use its source-date window without changing
     * the existing Jobs route's lifecycle contract.
     */
    githubFeedActive: { type: Boolean, default: null },
    /**
     * When the listing stops being shown — `createdAt + 21 days`, filled in by
     * the hook below. Defaults to null rather than a date so an explicitly
     * supplied deadline (a source that publishes one) is never overwritten, and
     * so a legacy row without the field reads the same way as a new one.
     */
    expiresAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: 'jobs',
  },
);

export type Job = InferSchemaType<typeof jobSchema>;
export type JobDocument = HydratedDocument<Job>;

/** A MongoDB query filter. Matches the shape the routes already build by hand. */
export type JobQueryFilter = Record<string, unknown>;

/**
 * Every stored job gets an expiry, and it is always exactly 21 days after the
 * document's own `createdAt`.
 *
 * This runs on save rather than as a schema default because `timestamps` only
 * stamps `createdAt` once saving starts: reading it here is what ties the two
 * fields together to the millisecond instead of leaving them a few apart. An
 * expiry the caller supplied — a deadline the source published — is left
 * untouched, and so is one already stored on an existing document.
 */
jobSchema.pre('save', function fillExpiresAt(this: JobDocument) {
  if (this.expiresAt === null || this.expiresAt === undefined) {
    const createdAt = (this as { createdAt?: Date }).createdAt;
    this.expiresAt = jobExpiryFrom(createdAt ?? new Date());
  }
});

/**
 * Last-resort net: the database itself refuses an aggregator apply link.
 *
 * The real enforcement is `saveJob()`, which every write path goes through, and the
 * Zod schema in front of the routes. This exists because "every write path" is a
 * claim that has to stay true as the code grows — a validator on the field is
 * enforced by Mongoose for any `create`, `save` or `validate`, whoever wrote the
 * caller and whether or not they remembered the helper.
 *
 * Deliberately narrow. It rejects only the verdict that is *definitely* wrong —
 * `aggregator`, which covers a known aggregator host and a link back at our own
 * site — and lets `suspicious`, `wrapper` and `unresolvable` through, because those
 * are cases a human resolves through the review queue and blocking them here would
 * only lose the row. It also allows null and empty: no link is a valid state.
 *
 * `updateOne`/`$set` does not run this by default, which is why the backfill and
 * the review queue classify explicitly before writing rather than relying on it.
 */
jobSchema.path('applyUrl').validate({
  validator: function validateApplyUrlIsNotAggregator(value: string | null | undefined): boolean {
    if (!env.APPLY_URL_ENFORCE) return true;
    if (!value || value.trim().length === 0) return true;

    return classifyApplyUrl(value).verdict !== 'aggregator';
  },
  message: (props: { value: string }) =>
    `applyUrl points at a job aggregator or back at this site, which is never an application destination: ${props.value}`,
});

// Deduplication: same channel + message ID must never be stored twice.
jobSchema.index({ telegramChannel: 1, telegramMessageId: 1 }, { unique: true });
// Non-Telegram sources can upsert by their own deterministic identity. The
// partial index leaves legacy Telegram documents (which have no sourceId) alone.
jobSchema.index(
  { source: 1, sourceId: 1 },
  { unique: true, partialFilterExpression: { sourceId: { $type: 'string' } } },
);
// Query by recency.
jobSchema.index({ postedAt: -1 });
// Every user-facing query starts by narrowing to the listings still on show.
jobSchema.index({ status: 1, expiresAt: -1 });
jobSchema.index({ source: 1, githubFeedActive: 1, postedAt: -1 });
// The admin review queue reads by status, oldest-checked first.
jobSchema.index({ applyUrlStatus: 1, applyUrlCheckedAt: 1 });

export const JobModel = model<Job>('Job', jobSchema);

/**
 * The clauses that decide whether a listing is visible to a user.
 *
 * A job shows up only while it is `active`, its optional source deadline has not
 * passed, and its source `postedAt` is within the 15-day public-feed window.
 * Both lifecycle halves tolerate a document stored before those fields existed:
 * in MongoDB a `null` match also matches a missing field, so a legacy row counts
 * as active when its stored source date is inside that same 15-day window.
 *
 * Apply-link verification is deliberately *not* one of these clauses. A listing is
 * worth showing on its own merits — company, role, batch, description — and
 * `applyUrlVerified` only decides whether the card can offer an Apply button.
 * Gating visibility on it hid whole postings while background discovery was still
 * pending, which is a far worse outcome than a card whose Apply button is not
 * live yet.
 *
 * Returned as separate clauses so a route can add its own filters alongside them
 * without either side clobbering the other's `$or`.
 */
export function activeJobClauses(now: Date = new Date()): JobQueryFilter[] {
  const utcToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const sourceCutoff = new Date(utcToday.getTime() - JOB_SOURCE_ACTIVE_WINDOW_MS);

  return [
    { $or: [{ status: JOB_STATUS_ACTIVE }, { status: null }] },
    {
      $or: [
        { expiresAt: { $gt: now } },
        {
          expiresAt: null,
          postedAt: { $gte: sourceCutoff },
        },
      ],
    },
    // The source date is the authority for public age. This clause also applies
    // to legacy rows with an expiry, so an import today cannot revive an old post.
    { postedAt: { $gte: sourceCutoff } },
  ];
}

/**
 * Sources that have their own dedicated feed, and so are excluded from `/jobs`.
 *
 * Only GitHub Global Internships today. Kept as a list so adding a second such
 * feed is one entry here rather than another `$ne` in every route.
 */
export function dedicatedFeedSourceClauses(sources: readonly string[]): JobQueryFilter[] {
  return sources.length === 0 ? [] : [{ source: { $nin: [...sources] } }];
}

/** `activeJobClauses` as one filter, for a query with nothing else to add. */
export function activeJobFilter(now: Date = new Date()): JobQueryFilter {
  return { $and: activeJobClauses(now) };
}

/**
 * A logo already stored for this company on some earlier job, or null.
 *
 * The reuse path for logo lookups: a channel routinely posts many roles for one
 * employer, and the first of them is the only one that should cost a request.
 * The in-process cache covers a single run; this covers a restart, so a company
 * resolved last week is never probed again.
 *
 * Matched case-insensitively on the exact stored name, which is the same company
 * by any reasonable reading. Never throws for a caller — an unusable name
 * answers null without a query.
 */
export async function findStoredCompanyLogoUrl(
  company: string | null | undefined,
): Promise<string | null> {
  const name = company?.trim();
  if (name === undefined || name.length === 0) return null;

  const doc = await JobModel.findOne({
    company: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    companyLogoUrl: { $nin: [null, ''] },
  })
    .select({ companyLogoUrl: 1 })
    .lean<{ companyLogoUrl?: string | null } | null>();

  return doc?.companyLogoUrl?.trim() || null;
}
