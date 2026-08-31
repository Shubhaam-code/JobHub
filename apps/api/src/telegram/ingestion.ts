/**
 * Per-message ingestion pipeline.
 *
 * pre-filter → LLM classify → sanitize/ground → validate → deduplicate/insert → log
 *
 * Channel-agnostic: the same path runs for every entry in TELEGRAM_CHANNELS, so
 * adding a channel needs no code change.
 */

import { logger } from '../lib/logger.js';
import { broadcastNewJob } from '../lib/socket.js';
import { JobModel } from '../models/job.model.js';
import { formatJob, type MongoJobDoc, type PublicJob } from '../routes/jobs.route.js';
import { classifyJobPost, type ClassifiedJob } from './job-classifier.js';
import { prefilterMessage } from './job-prefilter.js';
import { validateClassifiedJob } from './job-validator.js';

export type IngestionOutcome = 'inserted' | 'duplicate' | 'skipped' | 'error';

export interface IngestionInput {
  text: string;
  messageId: number;
  /** Unix timestamp (seconds) from Telegram. */
  date: number;
  channelUsername: string;
}

export interface IngestionResult {
  outcome: IngestionOutcome;
  messageId: number;
  reason?: string;
  job?: PublicJob;
}

/**
 * Outcome of evaluating one post's text, independent of storage.
 *
 * `not-job` is a decision ("this is promotion"), `unavailable` is the absence of
 * one (no API key, provider error, timeout, unusable output). Keeping them apart
 * matters: a post may only be discarded on a decision, never on a failure.
 */
export type EvaluationResult =
  | { verdict: 'job'; job: ClassifiedJob }
  | { verdict: 'not-job'; reason: string }
  | { verdict: 'unavailable'; reason: string };

/** MongoDB duplicate key error code. */
const DUPLICATE_KEY_ERROR_CODE = 11000;

function buildMessageUrl(channelUsername: string, messageId: number): string {
  return `https://t.me/${channelUsername}/${messageId}`;
}

/**
 * Runs the classification half of the pipeline: pre-filter, LLM, validation.
 *
 * Shared by live ingestion, the backfill and the stored-data cleanup so all
 * three judge a post by exactly the same rules.
 */
export async function evaluateJobPost(text: string): Promise<EvaluationResult> {
  if (!text || text.trim().length === 0) {
    return { verdict: 'not-job', reason: 'no text' };
  }

  // 1. Cheap local pre-filter — keeps obvious noise away from the LLM.
  const prefilter = prefilterMessage(text);
  if (!prefilter.send) {
    return { verdict: 'not-job', reason: prefilter.reason ?? 'filtered locally' };
  }

  // 2. LLM classification + extraction (structured JSON, never free-form).
  const classification = await classifyJobPost(text);
  if (!classification.ok) {
    // A provider/parse failure is not a verdict — the post stays undecided.
    return { verdict: 'unavailable', reason: classification.reason };
  }

  // 3. Deterministic validation has the final word.
  const validation = validateClassifiedJob(classification.job);
  if (!validation.valid) {
    return { verdict: 'not-job', reason: validation.reason ?? 'failed validation' };
  }

  return { verdict: 'job', job: classification.job };
}

/**
 * Processes a single Telegram message through the full ingestion pipeline.
 *
 * Errors are caught per-message so one malformed post cannot crash the listener.
 */
export async function ingestMessage(input: IngestionInput): Promise<IngestionResult> {
  const { text, messageId, date, channelUsername } = input;

  // Every log line names its channel so multi-channel activity stays readable.
  const ref = `[@${channelUsername} msg ${messageId}]`;

  try {
    if (!text || text.trim().length === 0) {
      logger.debug(`${ref} skipped → no text`);
      return { outcome: 'skipped', messageId, reason: 'no text' };
    }

    const evaluation = await evaluateJobPost(text);

    if (evaluation.verdict !== 'job') {
      // 'unavailable' is logged at info: a key/provider problem should be visible.
      const line = `${ref} skipped → ${evaluation.reason}`;
      if (evaluation.verdict === 'unavailable') {
        logger.warn(line);
      } else {
        logger.debug(line);
      }
      return { outcome: 'skipped', messageId, reason: evaluation.reason };
    }

    const { job } = evaluation;

    const doc = {
      company: job.company,
      role: job.role,
      batch: job.batch,
      applyUrl: job.applyUrl,
      location: job.location,
      employmentType: job.employmentType,
      source: 'telegram',
      telegramChannel: channelUsername,
      telegramMessageId: messageId,
      telegramMessageUrl: buildMessageUrl(channelUsername, messageId),
      originalText: text,
      postedAt: new Date(date * 1000),
    };

    // The unique (telegramChannel, telegramMessageId) index handles dedup.
    const created = await JobModel.create(doc);
    const publicJob = formatJob(created.toObject() as unknown as MongoJobDoc);

    broadcastNewJob(publicJob);

    logger.info(
      `${ref} job detected → ${job.company ?? '(no company)'} / ${job.role ?? '(no role)'}`,
    );
    return { outcome: 'inserted', messageId, job: publicJob };
  } catch (error: unknown) {
    // Duplicate key on the compound index → idempotent, not an error.
    if (isDuplicateKeyError(error)) {
      logger.debug(`${ref} already processed (duplicate)`);
      return { outcome: 'duplicate', messageId };
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.error(`${ref} error → ${message}`);
    return { outcome: 'error', messageId, reason: message };
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  // Mongoose wraps the MongoDB driver error.
  const asAny = error as Record<string, unknown>;
  return asAny['code'] === DUPLICATE_KEY_ERROR_CODE;
}
