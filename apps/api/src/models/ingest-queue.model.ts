import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Lifecycle of a queued Telegram message.
 *
 *  pending    — normalized, waiting for a worker
 *  processing — claimed by a worker, LLM call in flight
 *  completed  — classified and either stored as a job or discarded as not-a-job
 *  retry_wait — a transient failure (rate limit, timeout); retry due at nextRetryAt
 *  failed     — permanently dead; kept as a dead-letter record, never retried
 */
export const QUEUE_STATUSES = [
  'pending',
  'processing',
  'completed',
  'retry_wait',
  'failed',
] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

/**
 * One Telegram message awaiting (or past) LLM classification.
 *
 * This collection IS the queue. It lives in MongoDB rather than in memory so a
 * restart, a crash or an LLM outage cannot lose a message: whatever was
 * `pending`, `processing` or `retry_wait` is still here on the next boot.
 *
 * Normalization has already run by the time a document exists, so `cleanedText`
 * and `applyUrl` are stored alongside the raw post — the worker never has to
 * re-derive them, and the apply URL cannot drift.
 */
const ingestQueueSchema = new Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────
    /**
     * `${channelId ?? lowercased username}:${messageId}`. Deduplication key.
     * Unique, so two ingestion paths racing on the same message resolve to one
     * insert and one duplicate — enforced by the database, not by a read-then-write.
     */
    messageKey: { type: String, required: true, trim: true },

    // ── Provenance ────────────────────────────────────────────────────────
    source: { type: String, required: true, trim: true },
    telegramChannel: { type: String, required: true, trim: true },
    telegramChannelId: { type: String, default: null },
    telegramMessageId: { type: Number, required: true },
    telegramMessageUrl: { type: String, default: null },
    postedAt: { type: Date, required: true },

    // ── Normalized payload ────────────────────────────────────────────────
    /** Raw post, for debugging/auditing and for grounding LLM output. */
    rawMessage: { type: String, required: true },
    /** Promotion-free post text: what the LLM reads and what users see. */
    cleanedText: { type: String, required: true },
    /** Apply URL copied verbatim from the raw post, before any LLM call. */
    applyUrl: { type: String, default: null },

    // ── Processing state ──────────────────────────────────────────────────
    status: {
      type: String,
      enum: QUEUE_STATUSES,
      default: 'pending',
      required: true,
    },
    attempts: { type: Number, default: 0, required: true },
    lastError: { type: String, default: null },
    receivedAt: { type: Date, required: true },
    processedAt: { type: Date, default: null },
    /** When a `retry_wait` job becomes claimable again. */
    nextRetryAt: { type: Date, default: null },
    /** Set when a worker claims the job; used to recover abandoned claims. */
    claimedAt: { type: Date, default: null },
    /** The job created from this message, when classification produced one. */
    jobId: { type: Schema.Types.ObjectId, ref: 'Job', default: null },
  },
  {
    timestamps: true,
    collection: 'ingest_queue',
  },
);

// Deduplication, primary form.
ingestQueueSchema.index({ messageKey: 1 }, { unique: true });
// Deduplication, defence in depth: holds even if a channel is seen under both
// its numeric ID and its username, which would produce two different messageKeys.
ingestQueueSchema.index({ telegramChannel: 1, telegramMessageId: 1 }, { unique: true });
// The claim query: oldest claimable job first.
ingestQueueSchema.index({ status: 1, nextRetryAt: 1, receivedAt: 1 });

export type IngestQueueEntry = InferSchemaType<typeof ingestQueueSchema>;
export type IngestQueueDocument = HydratedDocument<IngestQueueEntry>;

export const IngestQueueModel = model<IngestQueueEntry>('IngestQueue', ingestQueueSchema);
