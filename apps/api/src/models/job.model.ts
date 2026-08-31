import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

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
    telegramMessageId: { type: Number, required: true },
    telegramMessageUrl: { type: String, default: null },
    originalText: { type: String, required: true },
    postedAt: { type: Date, required: true },
  },
  {
    timestamps: true,
    collection: 'jobs',
  },
);

// Deduplication: same channel + message ID must never be stored twice.
jobSchema.index({ telegramChannel: 1, telegramMessageId: 1 }, { unique: true });
// Query by recency.
jobSchema.index({ postedAt: -1 });

export type Job = InferSchemaType<typeof jobSchema>;
export type JobDocument = HydratedDocument<Job>;

export const JobModel = model<Job>('Job', jobSchema);
