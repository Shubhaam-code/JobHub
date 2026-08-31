/**
 * Re-evaluates jobs already stored in MongoDB with the current classification
 * logic, removing the ones that are not genuine opportunities and refreshing
 * the extracted fields of the ones that are.
 *
 *   npm run jobs:cleanup --workspace @jia/api -- --dry-run
 *   npm run jobs:cleanup --workspace @jia/api
 *
 * Flags:
 *   --dry-run          report only, change nothing
 *   --configured-only  restrict to channels currently in TELEGRAM_CHANNELS
 *                      (default: every stored Telegram job, including posts from
 *                      channels that have since been removed from the list)
 *
 * Documents are identified by telegramChannel + telegramMessageId, and
 * `originalText` — the post as Telegram sent it — is the only input, so a
 * document is judged exactly as a fresh message would be.
 *
 * A post is deleted only on a definite "not a job" verdict. When the classifier
 * cannot reach a verdict (no API key, provider error, timeout), the document is
 * left untouched.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isLlmConfigured, llmModelName } from '../llm/client.js';
import { JobModel } from '../models/job.model.js';
import { evaluateJobPost } from '../telegram/ingestion.js';

const DRY_RUN = process.argv.includes('--dry-run');
const CONFIGURED_ONLY = process.argv.includes('--configured-only');

interface StoredJob {
  _id: unknown;
  company: string | null;
  role: string | null;
  batch: string | null;
  applyUrl: string | null;
  location?: string | null;
  employmentType?: string | null;
  telegramChannel: string;
  telegramMessageId: number;
  originalText: string;
}

/** Fields the re-evaluation may change. */
const EXTRACTED_FIELDS = [
  'company',
  'role',
  'batch',
  'applyUrl',
  'location',
  'employmentType',
] as const;

async function main(): Promise<void> {
  if (!isLlmConfigured()) {
    throw new Error(
      'GEMINI_API_KEY is not set. Cleanup re-classifies stored posts, so without a key it could ' +
        'only leave everything untouched. Set it in apps/api/.env and re-run.',
    );
  }

  logger.info(`[cleanup] Classifier model: ${llmModelName()}`);
  logger.info(`[cleanup] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — cleanup needs a working database.');
  }

  const filter: Record<string, unknown> = CONFIGURED_ONLY
    ? {
        telegramChannel: {
          $in: env.telegramChannels.map((name) => new RegExp(`^${name}$`, 'i')),
        },
      }
    : {};

  const docs = await JobModel.find(filter).lean<StoredJob[]>();

  logger.info(
    `[cleanup] Re-evaluating ${docs.length} stored job(s)` +
      (CONFIGURED_ONLY ? ' from configured channels' : '') +
      (DRY_RUN ? ' — DRY RUN, nothing will be written.' : '.'),
  );

  let kept = 0;
  let updated = 0;
  let removed = 0;
  let undecided = 0;

  for (const doc of docs) {
    const ref = `[@${doc.telegramChannel} msg ${doc.telegramMessageId}]`;
    const evaluation = await evaluateJobPost(doc.originalText);

    if (evaluation.verdict === 'unavailable') {
      undecided += 1;
      logger.warn(`${ref} left untouched → ${evaluation.reason}`);
      continue;
    }

    if (evaluation.verdict === 'not-job') {
      removed += 1;
      logger.info(`${ref} removing → ${evaluation.reason}`);
      if (!DRY_RUN) {
        await JobModel.deleteOne({ _id: doc._id });
      }
      continue;
    }

    // Genuine job: keep it, refreshing any field the new extraction improves.
    const { job } = evaluation;
    const changes: Record<string, string | null> = {};

    for (const field of EXTRACTED_FIELDS) {
      const next = job[field];
      const current = doc[field] ?? null;
      if (next !== current) changes[field] = next;
    }

    kept += 1;

    if (Object.keys(changes).length === 0) {
      logger.debug(
        `${ref} kept unchanged → ${job.company ?? '(no company)'} / ${job.role ?? '(no role)'}`,
      );
      continue;
    }

    updated += 1;
    logger.info(
      `${ref} kept + updated → ${job.company ?? '(no company)'} / ${job.role ?? '(no role)'} ` +
        `[${Object.keys(changes).join(', ')}]`,
    );

    if (!DRY_RUN) {
      await JobModel.updateOne({ _id: doc._id }, { $set: changes });
    }
  }

  const remaining = DRY_RUN ? docs.length - removed : await JobModel.countDocuments();

  console.log('');
  console.log(`Cleanup summary${DRY_RUN ? ' (DRY RUN — nothing written)' : ''}:`);
  console.log(`  examined:  ${docs.length}`);
  console.log(`  kept:      ${kept} (of which updated: ${updated})`);
  console.log(`  removed:   ${removed}`);
  console.log(`  undecided: ${undecided} (left untouched)`);
  console.log(`  jobs now:  ${remaining}`);

  await disconnectDatabase();
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[cleanup] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
