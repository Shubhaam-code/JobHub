/**
 * Backfill: queues apply-link discovery for jobs already stored in MongoDB.
 *
 *   npm run jobs:discover-apply-urls --workspace @jia/api -- --dry-run
 *   npm run jobs:discover-apply-urls --workspace @jia/api -- --limit=50
 *   npm run jobs:discover-apply-urls --workspace @jia/api
 *
 * Flags:
 *   --dry-run        report what would be queued without writing anything
 *   --limit=<n>      stop after n candidate jobs (a small n makes a safe probe)
 *   --pause=<ms>     wait between enqueues (default 0). Only useful to spread the
 *                    write load on a shared cluster; the queue itself is paced by
 *                    the worker, not by this script.
 *   --all            also re-queue rows already marked `not_available`, i.e. rows
 *                    a previous discovery run looked at and could not verify
 *
 * Why this exists: discovery is triggered from the write path, so it covers every
 * job ingested from now on. Rows stored before it existed were never enqueued, so
 * their Apply button stays unavailable forever even where a link is findable —
 * and a Telegram row that is not verified is not even visible in the feed. This
 * walks that backlog once.
 *
 * What it does *not* do: discover anything itself. It only enqueues, and the
 * running worker does the work — so this script cannot disagree with the live
 * pipeline about what a valid apply link is, and it finishes in seconds rather
 * than holding a long-lived process open while it scrapes.
 *
 * Safe to re-run. `enqueueDiscoveryJob` upserts on `jobId`, so a second run resets
 * an existing row to `pending` rather than creating a duplicate.
 *
 * Jobs are streamed from a cursor, so memory does not scale with the collection.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { enqueueDiscoveryJob, type EnqueueDiscoveryOutcome } from '../apply-discovery/queue.js';
import { activeJobFilter, JobModel } from '../models/job.model.js';

const DRY_RUN = process.argv.includes('--dry-run');
const INCLUDE_EXHAUSTED = process.argv.includes('--all');

/** Reads `--flag=<number>`, falling back to `fallback` when absent or invalid. */
function numericFlag(name: string, fallback: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (raw === undefined) return fallback;

  const value = Number(raw.slice(name.length + 3));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative number (got "${raw}")`);
  }

  return Math.floor(value);
}

const LIMIT = numericFlag('limit', 0);
const PAUSE_MS = numericFlag('pause', 0);

/** The shape the cursor reads — only the fields the queue row needs. */
interface StoredJobForDiscovery {
  _id: unknown;
  company?: string | null;
  role?: string | null;
  location?: string | null;
  employmentType?: string | null;
  batch?: string | null;
  applyUrl?: string | null;
  applyUrlStatus?: string | null;
  sourceUrl?: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  logger.info(`[apply-backfill] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — the backfill needs a working database.');
  }

  if (!env.APPLY_DISCOVERY_ENABLED && !DRY_RUN) {
    throw new Error(
      'APPLY_DISCOVERY_ENABLED is false, so no worker is running to drain what this script queues. ' +
        'Set it to true in apps/api/.env and re-run, or pass --dry-run to see the candidates.',
    );
  }

  /* Only rows that need it, and only rows worth spending discovery on.
     - `applyUrlVerified: { $ne: true }` is the population, matching both `false`
       and documents stored before the field existed.
     - The active filter excludes expired postings: verifying a link nobody can
       see helps nobody, and the backlog of expired rows dwarfs the live one.
     - `not_available` rows are excluded by default because a previous run already
       looked and found nothing; `--all` re-queues them, which is the right thing
       after a discovery improvement but wasteful as a routine. */
  const filter: Record<string, unknown> = {
    ...activeJobFilter(),
    applyUrlVerified: { $ne: true },
    ...(INCLUDE_EXHAUSTED ? {} : { applyUrlStatus: { $ne: 'not_available' } }),
  };

  const total = await JobModel.countDocuments(filter);

  logger.info(
    `[apply-backfill] Scanning ${total} active job(s) without a verified apply link` +
      (INCLUDE_EXHAUSTED ? ', including previously exhausted rows' : '') +
      (LIMIT > 0 ? `, stopping after ${LIMIT} candidate(s)` : '') +
      (DRY_RUN ? ' — DRY RUN, nothing will be queued.' : '.'),
  );

  // Oldest first: the rows that have been unapplyable longest get a link soonest.
  const cursor = JobModel.find(filter)
    .select({
      company: 1,
      role: 1,
      location: 1,
      employmentType: 1,
      batch: 1,
      applyUrl: 1,
      applyUrlStatus: 1,
      sourceUrl: 1,
    })
    .sort({ createdAt: 1, _id: 1 })
    .lean<StoredJobForDiscovery>()
    .cursor();

  const summary = {
    examined: 0,
    queued: 0,
    requeued: 0,
    skippedNoLead: 0,
    errors: 0,
  };

  try {
    for await (const job of cursor) {
      if (LIMIT > 0 && summary.examined >= LIMIT) break;
      summary.examined += 1;

      /* Discovery needs something to work from: a company name to match a careers
         site against, or a URL to start from. A row with neither would burn a
         worker slot to conclude it has nothing to go on. */
      const hasLead =
        (job.company ?? '').trim().length > 0 ||
        (job.applyUrl ?? '').trim().length > 0 ||
        (job.sourceUrl ?? '').trim().length > 0;

      if (!hasLead) {
        summary.skippedNoLead += 1;
        continue;
      }

      if (DRY_RUN) {
        summary.queued += 1;
        continue;
      }

      try {
        const result: { outcome: EnqueueDiscoveryOutcome } = await enqueueDiscoveryJob({
          jobId: String(job._id),
          company: job.company ?? null,
          role: job.role ?? null,
          location: job.location ?? null,
          employmentType: job.employmentType ?? null,
          batch: job.batch ?? null,
          sourceUrl: job.sourceUrl ?? null,
          initialApplyUrl: job.applyUrl ?? null,
          initialCandidates: null,
        });

        if (result.outcome === 'queued') summary.queued += 1;
        else summary.requeued += 1;
      } catch (error: unknown) {
        summary.errors += 1;
        logger.warn(
          `[apply-backfill] could not queue jobId=${String(job._id)} -> ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (PAUSE_MS > 0) await sleep(PAUSE_MS);
    }

    console.log('');
    console.log(`Apply-link discovery backfill${DRY_RUN ? ' (DRY RUN — nothing queued)' : ''}:`);
    console.log(`  examined:      ${summary.examined}`);
    console.log(`  ${DRY_RUN ? 'would queue:' : 'queued:     '}   ${summary.queued}`);
    if (!DRY_RUN) {
      console.log(`  re-queued:     ${summary.requeued} (already had a discovery row)`);
    }
    console.log(`  no lead:       ${summary.skippedNoLead} (no company and no URL to start from)`);
    console.log(`  errors:        ${summary.errors} (left unqueued)`);

    if (DRY_RUN && summary.queued > 0) {
      console.log('');
      console.log('Re-run without --dry-run to queue these jobs.');
    } else if (!DRY_RUN && summary.queued + summary.requeued > 0) {
      console.log('');
      console.log(
        'The running API worker drains this queue in the background; Apply buttons ' +
          'update over Socket.IO as each job verifies.',
      );
    }
  } finally {
    // Closes the cursor even when the run was cut short, so the server-side
    // cursor is not left open until it times out.
    await cursor.close().catch(() => {});
    await disconnectDatabase();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[apply-backfill] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
