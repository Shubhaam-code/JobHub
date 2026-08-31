import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

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

    // ── Provenance ────────────────────────────────────────────────────────
    source: { type: String, required: true, trim: true },
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

// Deduplication: same channel + message ID must never be stored twice.
jobSchema.index({ telegramChannel: 1, telegramMessageId: 1 }, { unique: true });
// Query by recency.
jobSchema.index({ postedAt: -1 });
// Every user-facing query starts by narrowing to the listings still on show.
jobSchema.index({ status: 1, expiresAt: -1 });

export const JobModel = model<Job>('Job', jobSchema);

/**
 * The clauses that decide whether a listing is visible to a user.
 *
 * A job shows up only while it is `active` and its `expiresAt` is still in the
 * future. Both halves tolerate a document stored before those fields existed:
 * in MongoDB a `null` match also matches a missing field, so a legacy row counts
 * as active and has its 21-day window measured from `createdAt` instead — the
 * same rule, applied to the data that row does have.
 *
 * Returned as separate clauses so a route can add its own filters alongside them
 * without either side clobbering the other's `$or`.
 */
export function activeJobClauses(now: Date = new Date()): JobQueryFilter[] {
  return [
    { $or: [{ status: JOB_STATUS_ACTIVE }, { status: null }] },
    {
      $or: [
        { expiresAt: { $gt: now } },
        {
          expiresAt: null,
          createdAt: { $gt: new Date(now.getTime() - JOB_ACTIVE_WINDOW_MS) },
        },
      ],
    },
  ];
}

/** `activeJobClauses` as one filter, for a query with nothing else to add. */
export function activeJobFilter(now: Date = new Date()): JobQueryFilter {
  return { $and: activeJobClauses(now) };
}
