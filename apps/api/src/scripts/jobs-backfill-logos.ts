/**
 * One-time backfill: fills in `companyLogoUrl` on jobs already stored in MongoDB
 * that have no logo yet.
 *
 *   npm run jobs:backfill-logos --workspace @jia/api -- --dry-run
 *   npm run jobs:backfill-logos --workspace @jia/api
 *
 * Flags:
 *   --dry-run        report every change without writing anything (run this first)
 *   --limit=<n>      stop after n candidate jobs (a small n makes a safe probe)
 *   --pause=<ms>     wait between provider lookups (default 300). Only applied
 *                    after a real lookup, so many jobs for one company cost one
 *                    pause, not one per row.
 *
 * The resolution itself is `resolveCompanyLogo` — the same function the queue
 * worker uses on every new post — so this script cannot disagree with the live
 * pipeline about which company names are usable or which logo belongs to one.
 *
 * What it will not do: write any field other than `companyLogoUrl`, overwrite a
 * logo a job already has, delete a job, merge duplicates, or change a job whose
 * company has no findable logo. Re-running is a no-op, because a populated row is
 * skipped by the same check that selected it.
 *
 * Jobs are streamed from a cursor, so memory does not scale with the collection.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobModel } from '../models/job.model.js';
import {
  runCompanyLogoBackfill,
  type StoredJobLogo,
} from '../telegram/company-logo-backfill.js';

const DRY_RUN = process.argv.includes('--dry-run');

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
const PAUSE_MS = numericFlag('pause', 300);

async function main(): Promise<void> {
  logger.info(`[logo-backfill] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — the backfill needs a working database.');
  }

  if (!env.COMPANY_LOGO_ENABLED) {
    throw new Error(
      'COMPANY_LOGO_ENABLED is false, so the resolver would find nothing and this run could only ' +
        'report zero changes. Set it to true in apps/api/.env and re-run.',
    );
  }

  /* Only rows that have a company and no logo yet. `$in: [null, '']` also matches
     a document stored before the field existed, which is the whole population this
     script is for. */
  const filter = {
    company: { $nin: [null, ''] },
    companyLogoUrl: { $in: [null, ''] },
  };
  const total = await JobModel.countDocuments(filter);

  logger.info(
    `[logo-backfill] Scanning ${total} job(s) with a company and no logo` +
      (LIMIT > 0 ? `, stopping after ${LIMIT} candidate(s)` : '') +
      (DRY_RUN ? ' — DRY RUN, nothing will be written.' : '.'),
  );

  /* Sorted by company so every job for one employer is consecutive: the run's own
     per-company memo then answers all but the first of them, which is what keeps
     the number of provider requests at one per company. */
  const cursor = JobModel.find(filter)
    .select({ company: 1, companyLogoUrl: 1, telegramChannel: 1, telegramMessageId: 1 })
    .sort({ company: 1, _id: 1 })
    .lean<StoredJobLogo>()
    .cursor();

  try {
    const summary = await runCompanyLogoBackfill({
      jobs: cursor,
      dryRun: DRY_RUN,
      pauseMs: PAUSE_MS,
      limit: LIMIT,
    });

    console.log('');
    console.log(`Company logo backfill${DRY_RUN ? ' (DRY RUN — nothing written)' : ''}:`);
    console.log(`  examined:       ${summary.examined}`);
    console.log(`  candidates:     ${summary.candidates}`);
    console.log(`  already had:    ${summary.skippedHasLogo} (never overwritten)`);
    console.log(`  no company:     ${summary.skippedNoCompany} (skipped, no lookup)`);
    console.log(`  ${DRY_RUN ? 'would set:' : 'set:      '}      ${summary.updated}`);
    console.log(`  not found:      ${summary.notFound} (left unchanged)`);
    console.log(`  errors:         ${summary.errors} (left unchanged)`);
    console.log(`  lookups made:   ${summary.companiesResolved} (distinct companies)`);

    if (DRY_RUN && summary.updated > 0) {
      console.log('');
      console.log('Re-run without --dry-run to apply these changes.');
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
  logger.error(`[logo-backfill] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
