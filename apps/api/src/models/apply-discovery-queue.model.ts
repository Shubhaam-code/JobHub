/**
 * Apply Link Discovery Queue Model
 *
 * Separate queue for background apply URL discovery and verification.
 * Triggered automatically when new jobs are saved, processes independently
 * from the main ingestion queue to avoid blocking job creation.
 *
 * Flow:
 *   Job Created → Enqueue Discovery → Worker Claims → Universal Agent → Update Job
 */

import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Discovery job lifecycle states.
 *
 * - `pending`: waiting to be claimed by a worker
 * - `processing`: claimed and being worked on
 * - `completed`: apply URL verified and stored
 * - `not_found`: no valid apply URL could be discovered
 * - `retry_wait`: temporary failure, scheduled for retry
 * - `failed`: permanent failure after max attempts
 */
export const DISCOVERY_STATUSES = [
  'pending',
  'processing',
  'completed',
  'not_found',
  'retry_wait',
  'failed',
] as const;

export type DiscoveryStatus = (typeof DISCOVERY_STATUSES)[number];

/**
 * Discovery methods used to find the apply URL.
 */
export const DISCOVERY_METHODS = [
  'direct_extraction',
  'firecrawl_scrape',
  'web_search',
  'company_search',
  'none',
] as const;

export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number];

const applyDiscoveryQueueSchema = new Schema(
  {
    // ── Job Reference ─────────────────────────────────────────────────────
    /** The job document this discovery is for. */
    /* Indexed once, below, as `{ jobId: 1 }, { unique: true }`. Declaring
       `index: true` here as well makes it a duplicate definition, and Mongo keeps
       the first one it sees — dropping the uniqueness that `enqueueDiscoveryJob`
       relies on to turn a second enqueue into an update instead of a duplicate row. */
    jobId: { type: Schema.Types.ObjectId, required: true, ref: 'Job' },

    // ── Job Context for Discovery ─────────────────────────────────────────
    /**
     * Job metadata needed for discovery, denormalized so the agent doesn't
     * need to fetch the job document during processing.
     */
    company: { type: String, default: null },
    role: { type: String, default: null },
    location: { type: String, default: null },
    employmentType: { type: String, default: null },
    batch: { type: String, default: null },

    /** Source URL where the job was found (e.g., aggregator article). */
    sourceUrl: { type: String, default: null },

    /** Initial apply URL from job extraction, if any. */
    initialApplyUrl: { type: String, default: null },

    /** Initial candidates from aggregator page extraction, if any. */
    initialCandidates: { type: Schema.Types.Mixed, default: null },

    // ── Discovery Status ──────────────────────────────────────────────────
    status: {
      type: String,
      enum: DISCOVERY_STATUSES,
      default: 'pending',
      required: true,
      index: true,
    },

    /** Number of processing attempts made. */
    attempts: { type: Number, default: 0, required: true },

    /** When this job was first queued. */
    enqueuedAt: { type: Date, required: true, index: true },

    /** When a worker claimed this job. */
    claimedAt: { type: Date, default: null },

    /** When discovery completed (success or permanent failure). */
    completedAt: { type: Date, default: null },

    /** Next retry time for `retry_wait` status. */
    nextRetryAt: { type: Date, default: null, index: true },

    // ── Discovery Results ─────────────────────────────────────────────────
    /** Discovered and verified apply URL. */
    discoveredApplyUrl: { type: String, default: null },

    /** Whether the URL was successfully verified. */
    verified: { type: Boolean, default: false },

    /** Discovery method that found the URL. */
    discoveryMethod: { type: String, enum: DISCOVERY_METHODS, default: null },

    /**
     * Evidence supporting verification decision.
     * Contains: companyMatch, roleMatch, locationMatch, hasApplicationAction,
     * isOfficialSource, matchedSignals, etc.
     */
    verificationEvidence: { type: Schema.Types.Mixed, default: null },

    /** All candidates found during discovery, with scores and reasons. */
    candidates: { type: Schema.Types.Mixed, default: null },

    // ── Cost Tracking ─────────────────────────────────────────────────────
    /** Whether Firecrawl was used (for cost monitoring). */
    usedFirecrawl: { type: Boolean, default: false },

    /** Whether web search was used. */
    usedWebSearch: { type: Boolean, default: false },

    /** Total external API calls made. */
    externalApiCalls: { type: Number, default: 0 },

    // ── Error Tracking ────────────────────────────────────────────────────
    /** Last error message, for retry_wait and failed states. */
    lastError: { type: String, default: null },

    /** Human-readable reason for the final outcome. */
    reason: { type: String, default: null },
  },
  {
    timestamps: true,
    collection: 'apply_discovery_queue',
  },
);

export type ApplyDiscoveryQueue = InferSchemaType<typeof applyDiscoveryQueueSchema>;
export type ApplyDiscoveryQueueDocument = HydratedDocument<ApplyDiscoveryQueue>;

// Unique constraint: one discovery job per job document.
// If a job is re-queued, it updates the existing discovery entry.
applyDiscoveryQueueSchema.index({ jobId: 1 }, { unique: true });

// Query by status and retry timing for worker claims.
applyDiscoveryQueueSchema.index({ status: 1, nextRetryAt: 1, enqueuedAt: 1 });

// Query completed/failed jobs for analytics.
applyDiscoveryQueueSchema.index({ status: 1, completedAt: -1 });

// Track cost-intensive operations.
applyDiscoveryQueueSchema.index({ usedFirecrawl: 1, usedWebSearch: 1 });

export const ApplyDiscoveryQueueModel = model<ApplyDiscoveryQueue>(
  'ApplyDiscoveryQueue',
  applyDiscoveryQueueSchema,
);
