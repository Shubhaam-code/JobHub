/**
 * Consolidates duplicate apply-discovery rows and restores the unique index.
 *
 *   npm run apply-discovery:dedupe-queue --workspace @jia/api -- --dry-run
 *   npm run apply-discovery:dedupe-queue --workspace @jia/api
 *
 * The bug this repairs: `applyDiscoveryQueueSchema.index({ jobId: 1 }, { unique: true })`
 * has always been declared, but Mongo does not rebuild an index that already exists
 * with different options — so a database whose `jobId_1` was first created without
 * `unique` kept it that way, silently. Every enqueue then inserted another row, and
 * each extra row is another Firecrawl scrape and another web search for a question
 * an earlier row already answered.
 *
 * `enqueueDiscoveryJob` is now an atomic upsert, so it no longer *creates*
 * duplicates. It cannot remove the ones already there, and the unique index cannot
 * be built while they exist. That is this script's whole job.
 *
 * Scope, exactly:
 *   - Reads and writes `apply_discovery_queue` only. The `jobs` collection is never
 *     opened for writing — no job deleted, no apply URL touched, no
 *     `applyUrlVerified` changed. A verified job stays verified whatever happens
 *     here, because verification lives on the job document, not on the queue row.
 *   - Deletes only *surplus bookkeeping rows*: for each jobId with more than one
 *     row, every row except the one worth keeping. A jobId with a single row is
 *     never written to at all.
 *   - Never touches Telegram, GitHub/Global Internships, or the discovery agent.
 *
 * Which row survives, in order of preference:
 *   1. A verified `completed` row — it holds the evidence for the link the job is
 *      already serving, and is the one row a future enqueue must refuse to reset.
 *   2. A `processing` row — a worker holds this claim right now; deleting it would
 *      make that worker's completion write land on nothing.
 *   3. Otherwise the row that carries the most information: any row that spent
 *      external calls, then the most recently enqueued. Ties fall to the newest
 *      `_id`, so the choice is deterministic on a re-run.
 *
 * Idempotent: a second run finds no duplicates, deletes nothing, and re-asserts the
 * index. Bounded: one pass over the duplicate groups, no retry loop.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  ApplyDiscoveryQueueModel,
  type DiscoveryStatus,
} from '../models/apply-discovery-queue.model.js';

const DRY_RUN = process.argv.includes('--dry-run');

/** The index this repairs, by name and by key. */
const JOB_ID_INDEX_NAME = 'jobId_1';

interface QueueRow {
  _id: unknown;
  status?: DiscoveryStatus;
  verified?: boolean;
  usedFirecrawl?: boolean;
  usedWebSearch?: boolean;
  externalApiCalls?: number;
  enqueuedAt?: Date;
  discoveredApplyUrl?: string | null;
}

/**
 * Ranks two rows for the same job; the higher rank is kept.
 *
 * Returns a positive number when `a` should win. Deliberately total and
 * deterministic — a comparator that could call two rows equal would make the
 * survivor depend on the order Mongo happened to return them in.
 */
function score(row: QueueRow): number[] {
  return [
    row.status === 'completed' && row.verified === true ? 1 : 0,
    row.status === 'processing' ? 1 : 0,
    (row.discoveredApplyUrl ?? '').length > 0 ? 1 : 0,
    row.externalApiCalls ?? 0,
    row.usedFirecrawl === true || row.usedWebSearch === true ? 1 : 0,
    row.enqueuedAt?.getTime() ?? 0,
  ];
}

function better(a: QueueRow, b: QueueRow): number {
  const left = score(a);
  const right = score(b);

  for (let index = 0; index < left.length; index += 1) {
    const a1 = left[index] ?? 0;
    const b1 = right[index] ?? 0;
    if (a1 !== b1) return a1 - b1;
  }

  // Same on every signal: newest _id wins, so the order is stable across runs.
  return String(a._id) > String(b._id) ? 1 : -1;
}

/** Why a given row was kept, for the log. */
function keepReason(row: QueueRow): string {
  if (row.status === 'completed' && row.verified === true) return 'verified result';
  if (row.status === 'processing') return 'worker holds the claim';
  if ((row.externalApiCalls ?? 0) > 0) return `spent ${String(row.externalApiCalls)} external call(s)`;
  return `newest (status=${row.status ?? 'unknown'})`;
}

/**
 * Asserts `{ jobId: 1 }` is unique, rebuilding it when it is not.
 *
 * Mongo cannot convert an index in place, so a non-unique `jobId_1` has to be
 * dropped and recreated. That is done last, after the duplicates are gone, and the
 * create is what proves the collection is actually clean — it fails loudly on a
 * remaining duplicate rather than leaving a half-fixed database behind.
 */
async function ensureUniqueJobIdIndex(): Promise<'already_unique' | 'rebuilt' | 'created'> {
  const collection = ApplyDiscoveryQueueModel.collection;
  const indexes = await collection.indexes();

  const existing = indexes.find(
    (index) => index.name === JOB_ID_INDEX_NAME || JSON.stringify(index.key) === '{"jobId":1}',
  );

  if (existing?.unique === true) return 'already_unique';

  if (existing !== undefined) {
    logger.info(`[dedupe-queue] dropping non-unique index ${String(existing.name)}`);
    await collection.dropIndex(String(existing.name));
    await collection.createIndex({ jobId: 1 }, { unique: true, name: JOB_ID_INDEX_NAME });
    return 'rebuilt';
  }

  await collection.createIndex({ jobId: 1 }, { unique: true, name: JOB_ID_INDEX_NAME });
  return 'created';
}

async function main(): Promise<void> {
  logger.info(`[dedupe-queue] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — this repair needs a working database.');
  }

  try {
    const totalRowsBefore = await ApplyDiscoveryQueueModel.countDocuments({});

    /* Group by jobId rather than streaming every row: only the groups with more
       than one row are of any interest, and there are ~100 of them against ~360
       rows. */
    const groups = await ApplyDiscoveryQueueModel.aggregate<{
      _id: unknown;
      rows: QueueRow[];
    }>([
      {
        $group: {
          _id: '$jobId',
          rows: {
            $push: {
              _id: '$_id',
              status: '$status',
              verified: '$verified',
              usedFirecrawl: '$usedFirecrawl',
              usedWebSearch: '$usedWebSearch',
              externalApiCalls: '$externalApiCalls',
              enqueuedAt: '$enqueuedAt',
              discoveredApplyUrl: '$discoveredApplyUrl',
            },
          },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ]).exec();

    const summary = {
      rowsBefore: totalRowsBefore,
      duplicateJobIds: groups.length,
      duplicateRows: groups.reduce((total, group) => total + group.rows.length, 0),
      keptVerified: 0,
      keptProcessing: 0,
      keptOther: 0,
      removed: 0,
    };

    console.log('');
    console.log(
      `apply_discovery_queue holds ${summary.rowsBefore} row(s); ` +
        `${summary.duplicateJobIds} job(s) have more than one ` +
        `(${summary.duplicateRows} rows between them)` +
        (DRY_RUN ? ' — DRY RUN, nothing is deleted.' : '.'),
    );

    const doomed: unknown[] = [];

    for (const group of groups) {
      const survivor = group.rows.reduce((best, row) => (better(row, best) > 0 ? row : best));

      if (survivor.status === 'completed' && survivor.verified === true) summary.keptVerified += 1;
      else if (survivor.status === 'processing') summary.keptProcessing += 1;
      else summary.keptOther += 1;

      for (const row of group.rows) {
        if (String(row._id) !== String(survivor._id)) doomed.push(row._id);
      }

      logger.debug(
        `[dedupe-queue] jobId=${String(group._id)} rows=${group.rows.length} ` +
          `keeping ${String(survivor._id)} (${keepReason(survivor)})`,
      );
    }

    console.log('');
    console.log('CONSOLIDATION PLAN');
    console.log(`  kept — verified result:      ${summary.keptVerified}`);
    console.log(`  kept — in-flight claim:      ${summary.keptProcessing}`);
    console.log(`  kept — newest/most useful:   ${summary.keptOther}`);
    console.log(`  surplus rows to remove:      ${doomed.length}`);
    console.log('');
    console.log('  jobs collection: not read for writing, not modified.');

    if (DRY_RUN) {
      console.log('');
      console.log('DRY RUN — no rows deleted, index left as it is.');
      console.log('Re-run without --dry-run to consolidate and rebuild the unique index.');
      return;
    }

    if (doomed.length > 0) {
      const deleted = await ApplyDiscoveryQueueModel.deleteMany({ _id: { $in: doomed } }).exec();
      summary.removed = deleted.deletedCount;
      logger.info(`[dedupe-queue] removed ${summary.removed} surplus queue row(s)`);
    }

    const indexState = await ensureUniqueJobIdIndex();

    const rowsAfter = await ApplyDiscoveryQueueModel.countDocuments({});
    const stillDuplicated = await ApplyDiscoveryQueueModel.aggregate([
      { $group: { _id: '$jobId', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $count: 'remaining' },
    ]).exec();

    console.log('');
    console.log('RESULT');
    console.log(`  rows before:        ${summary.rowsBefore}`);
    console.log(`  surplus removed:    ${summary.removed}`);
    console.log(`  rows after:         ${rowsAfter}`);
    console.log(`  duplicates left:    ${stillDuplicated[0]?.remaining ?? 0}`);
    console.log(`  jobId index:        unique (${indexState.replace('_', ' ')})`);
    console.log('');
    console.log(
      'One discovery row per job from here on: enqueueDiscoveryJob upserts on jobId, and the ' +
        'unique index rejects a second row if two enqueues ever race.',
    );
  } finally {
    await disconnectDatabase();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[dedupe-queue] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
