/**
 * Every change ever made to a stored apply link.
 *
 * The rule this collection exists to guarantee: **no apply-link write is
 * irreversible.** A row is written here *before* the job is updated, so if a
 * backfill run turns out to have been wrong, `--revert <runId>` can put every URL
 * back exactly as it was — including the ones that were cleared.
 *
 * Append-only by convention: nothing in this codebase updates or deletes a row.
 * The audit trail is worth more than the disk it costs.
 */

import { model, Schema, type HydratedDocument, type InferSchemaType } from 'mongoose';

import { APPLY_URL_STATUSES } from '../apply-url/status.js';

/** What kind of write produced this entry. */
export const APPLY_URL_AUDIT_ACTIONS = [
  'backfill',        // the automated repair replaced a link
  'backfill_review', // the automated repair could not decide; row flagged
  'body_rewrite',    // an anchor href inside the description was rewritten
  'admin_promote',   // a human picked one of the candidates
  'admin_manual',    // a human pasted a URL
  'admin_pending',   // a human marked it as "no link yet"
  'health_check',    // the scheduled re-check changed the status
  'revert',          // an earlier entry was undone
] as const;

export type ApplyUrlAuditAction = (typeof APPLY_URL_AUDIT_ACTIONS)[number];

const applyUrlAuditSchema = new Schema(
  {
    /** The job whose link changed. */
    postId: { type: Schema.Types.ObjectId, ref: 'Job', required: true, index: true },
    /**
     * Groups every entry from one script run, so a whole run can be reverted as a
     * unit. A human action gets its own id so it can be undone in isolation.
     */
    runId: { type: String, required: true, index: true },
    action: { type: String, enum: APPLY_URL_AUDIT_ACTIONS, required: true },
    /** The value before the write. Null is meaningful: the field was empty. */
    oldUrl: { type: String, default: null },
    /** The value after the write. Null means the link was cleared. */
    newUrl: { type: String, default: null },
    /** Status before and after, so a revert restores the whole decision. */
    oldStatus: { type: String, enum: [...APPLY_URL_STATUSES, null], default: null },
    newStatus: { type: String, enum: [...APPLY_URL_STATUSES, null], default: null },
    /** Previous `sourceUrl`, so a revert can also undo the provenance move. */
    oldSourceUrl: { type: String, default: null },
    /** The classifier's verdict on `newUrl`, for later analysis. */
    verdict: { type: String, default: null },
    /** Confidence score behind the choice, when one was scored. */
    score: { type: Number, default: null },
    /** Human-readable justification. */
    reason: { type: String, default: null },
    /**
     * Who did it: a script name (`jobs:fix-apply-urls`) or a user's email. Never
     * an anonymous write — an audit row that cannot name an actor is not an audit.
     */
    actor: { type: String, required: true },
    /**
     * For a body rewrite, the description before the change.
     *
     * Stored in full because a rewritten body cannot be reconstructed from a URL
     * pair — this is the only way back.
     */
    oldBody: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'apply_url_audit' },
);

export type ApplyUrlAudit = InferSchemaType<typeof applyUrlAuditSchema>;
export type ApplyUrlAuditDocument = HydratedDocument<ApplyUrlAudit>;

export const ApplyUrlAuditModel = model<ApplyUrlAudit>('ApplyUrlAudit', applyUrlAuditSchema);

/** A run id that sorts chronologically and is readable in a log line. */
export function newRunId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${prefix}-${stamp}`;
}
