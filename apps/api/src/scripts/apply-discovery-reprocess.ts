/**
 * Re-runs apply discovery for stored jobs that still have no verified link.
 *
 *   npm run apply-discovery:reprocess --workspace @jia/api -- --dry-run
 *   npm run apply-discovery:reprocess --workspace @jia/api
 *   npm run apply-discovery:reprocess --workspace @jia/api -- --days=14 --limit=10
 *
 * Why this exists next to `jobs:discover-apply-urls`: that script enqueues a
 * backlog and hands it to whatever worker happens to be running, then exits. This
 * one drains the rows it selected in-process and reports the outcome per row —
 * processed, newly verified, still unverified, failed, plus the Firecrawl and
 * web-search calls it cost. That report is the point: a re-run after turning an
 * escalation stage on is only worth doing if you can see what the stage bought.
 *
 * What it does NOT do:
 *   - Touch Telegram. No walk, no history, no messages. It reads stored rows only.
 *   - Reprocess a verified job. `applyUrlVerified: { $ne: true }` is the whole
 *     population, so the already-visible rows are never re-examined or re-billed.
 *   - Create jobs, delete jobs, or write a second discovery row. Enqueueing is the
 *     existing `enqueueDiscoveryJob` upsert on `jobId`.
 *   - Reimplement discovery. Each row goes through `processNextDiscoveryJob`, the
 *     same worker function the live API runs, so this cannot disagree with the
 *     live pipeline about what a valid apply link is.
 *
 * Bounded by construction: one pass over a fixed list of rows claimed up front,
 * one processing attempt each. A row that throws is handed to the existing
 * `scheduleDiscoveryRetry` backoff and left for the running worker — this script
 * never retries it itself, so there is no loop here to run away.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { enqueueDiscoveryJob, getDiscoveryOutcome } from '../apply-discovery/queue.js';
import { processNextDiscoveryJob } from '../apply-discovery/worker.js';
import { GITHUB_SOURCE } from '../github/sync.js';
import { activeJobFilter, JobModel } from '../models/job.model.js';

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Include Global Internships too. Off by default: that feed is GitHub-backed, has
 * its own page and its own sync, and its rows are not what a `/jobs` recovery is
 * about. The flag exists so the exclusion is a deliberate default rather than a
 * limitation of the script.
 */
const INCLUDE_GLOBAL = process.argv.includes('--include-global');

/** Reads `--flag=<number>`, falling back when absent. Rejects nonsense loudly. */
function numericFlag(name: string, fallback: number, min: number, max: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (raw === undefined) return fallback;

  const value = Number(raw.slice(name.length + 3));
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${name} must be a number between ${min} and ${max} (got "${raw}")`);
  }

  return Math.floor(value);
}

/** The window to reprocess, in days of `postedAt`. 0 means every active row. */
const DEFAULT_DAYS = 14;

interface Candidate {
  id: string;
  company: string | null;
  role: string | null;
  location: string | null;
  employmentType: string | null;
  batch: string | null;
  applyUrl: string | null;
  sourceUrl: string | null;
}

/** What one reprocess pass did. */
interface Report {
  /** Rows selected as needing a verified link. */
  selected: number;
  /** Rows with nothing for discovery to work from — not queued, not processed. */
  noLead: number;
  /** Discovery rows created by this run. */
  queuedNew: number;
  /** Discovery rows that already existed and were reset to pending. */
  requeued: number;
  /** Rows left alone: already verified, or a worker holds the claim right now. */
  skippedExisting: number;
  /** Rows a worker actually ran discovery on. */
  processed: number;
  /** Of those, the ones that came back with a verified apply URL. */
  newlyVerified: number;
  /** Of those, the ones that ran and found nothing — still hidden. */
  stillUnverified: number;
  /** Rows whose discovery threw and exhausted the bounded retry budget. */
  failed: number;
  /** Rows whose discovery threw and were handed back to the retry backoff. */
  retryScheduled: number;
  /** Firecrawl scrape/search calls this run spent. */
  firecrawlCalls: number;
  /** Web-search calls this run spent. */
  webSearchCalls: number;
  /** Total external API calls booked across the rows this run processed. */
  externalApiCalls: number;
  /** Enqueue attempts that errored before any discovery could run. */
  enqueueErrors: number;
}

/**
 * Rows that need a verified apply link.
 *
 * `applyUrlVerified: { $ne: true }` matches `false` and rows stored before the
 * field existed. The active filter is applied because verifying a link on an
 * expired posting nobody can see spends an API call for nothing.
 *
 * `not_available` rows are deliberately *included*: this script's whole purpose is
 * the re-run after an escalation stage was switched on, and "a previous attempt
 * found nothing" is exactly the population that attempt should now revisit.
 */
function candidateFilter(days: number): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [
    activeJobFilter(),
    { applyUrlVerified: { $ne: true } },
  ];

  if (!INCLUDE_GLOBAL) clauses.push({ source: { $ne: GITHUB_SOURCE } });

  if (days > 0) {
    clauses.push({ postedAt: { $gte: new Date(Date.now() - days * 24 * 60 * 60 * 1000) } });
  }

  return { $and: clauses };
}

/**
 * The cost of one discovery row, read back after it was processed.
 *
 * Taken from the queue document rather than accumulated here: the worker already
 * records `usedFirecrawl` / `usedWebSearch` / `externalApiCalls` per row, and
 * reading them back means the reported cost is the cost that was actually booked,
 * not a second tally that could disagree with it.
 *
 * Via `getDiscoveryOutcome`, which reads the *current* row. An earlier version did
 * its own `findOne({ jobId })` and, on a database that still held duplicate rows,
 * kept picking up an older one — so a run that spent 126 external calls reported
 * zero. Same reason the totals here also add `externalApiCalls`: a boolean per row
 * cannot show a job that was scraped and searched.
 */
async function readCosts(jobId: string): Promise<{
  firecrawl: boolean;
  webSearch: boolean;
  verified: boolean;
  calls: number;
}> {
  const outcome = await getDiscoveryOutcome(jobId);

  return {
    firecrawl: outcome?.usedFirecrawl === true,
    webSearch: outcome?.usedWebSearch === true,
    verified: outcome?.verified === true,
    calls: outcome?.externalApiCalls ?? 0,
  };
}

async function main(): Promise<void> {
  const days = numericFlag('days', DEFAULT_DAYS, 0, 365);
  const limit = numericFlag('limit', 0, 0, 5_000);

  /* The escalation stages are the reason to run this at all: with both off, every
     row gets direct extraction only — which is what already returned `not_found`
     for these rows. Refusing is more useful than quietly repeating that. */
  if (!DRY_RUN && !env.APPLY_DISCOVERY_ENABLE_FIRECRAWL && !env.APPLY_DISCOVERY_ENABLE_WEB_SEARCH) {
    throw new Error(
      'Both APPLY_DISCOVERY_ENABLE_FIRECRAWL and APPLY_DISCOVERY_ENABLE_WEB_SEARCH are false, so ' +
        'this run could only repeat the direct extraction that already failed for these rows. ' +
        'Set them to true in apps/api/.env and re-run.',
    );
  }

  if (
    !DRY_RUN &&
    (env.APPLY_DISCOVERY_ENABLE_FIRECRAWL || env.APPLY_DISCOVERY_ENABLE_WEB_SEARCH) &&
    !env.FIRECRAWL_API_KEY
  ) {
    throw new Error(
      'FIRECRAWL_API_KEY is not set, but the Firecrawl scrape and web-search stages both use it. ' +
        'Without the key those stages report "not configured" and this run would change nothing.',
    );
  }

  logger.info(`[reprocess] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — reprocessing needs a working database.');
  }

  const report: Report = {
    selected: 0,
    noLead: 0,
    queuedNew: 0,
    requeued: 0,
    skippedExisting: 0,
    processed: 0,
    newlyVerified: 0,
    stillUnverified: 0,
    failed: 0,
    retryScheduled: 0,
    firecrawlCalls: 0,
    webSearchCalls: 0,
    externalApiCalls: 0,
    enqueueErrors: 0,
  };

  try {
    /* Read the whole candidate list up front rather than streaming it. The list is
       what "these rows" means for the rest of the run: discovery writes
       `applyUrlVerified: true` as it goes, so a cursor over a filter that excludes
       verified rows would be walking a set that changes underneath it. */
    const candidates = await JobModel.find(candidateFilter(days))
      .select({
        company: 1,
        role: 1,
        location: 1,
        employmentType: 1,
        batch: 1,
        applyUrl: 1,
        sourceUrl: 1,
      })
      .sort({ postedAt: 1, _id: 1 })
      .limit(limit > 0 ? limit : 0)
      .lean<
        {
          _id: unknown;
          company?: string | null;
          role?: string | null;
          location?: string | null;
          employmentType?: string | null;
          batch?: string | null;
          applyUrl?: string | null;
          sourceUrl?: string | null;
        }[]
      >();

    report.selected = candidates.length;

    console.log('');
    console.log(
      `Reprocessing ${report.selected} stored job(s) without a verified apply link` +
        (days > 0 ? `, posted in the last ${days} days` : '') +
        (limit > 0 ? `, capped at ${limit}` : '') +
        (INCLUDE_GLOBAL ? ', including Global Internships' : '') +
        (DRY_RUN ? ' — DRY RUN, nothing is queued or processed.' : '.'),
    );
    console.log(
      `Stages: direct extraction always, ` +
        `firecrawl=${env.APPLY_DISCOVERY_ENABLE_FIRECRAWL ? 'on' : 'off'}, ` +
        `webSearch=${env.APPLY_DISCOVERY_ENABLE_WEB_SEARCH ? 'on' : 'off'}, ` +
        `maxExternalCalls=${env.APPLY_DISCOVERY_MAX_EXTERNAL_CALLS} per job.`,
    );

    /* Discovery needs something to work from: a company name to match a careers
       domain against, or a URL to start from. A row with neither would spend a
       worker slot to conclude it had nothing to go on. */
    const workable: Candidate[] = [];

    for (const job of candidates) {
      const candidate: Candidate = {
        id: String(job._id),
        company: job.company ?? null,
        role: job.role ?? null,
        location: job.location ?? null,
        employmentType: job.employmentType ?? null,
        batch: job.batch ?? null,
        applyUrl: job.applyUrl ?? null,
        sourceUrl: job.sourceUrl ?? null,
      };

      const hasLead =
        (candidate.company ?? '').trim().length > 0 ||
        (candidate.applyUrl ?? '').trim().length > 0 ||
        (candidate.sourceUrl ?? '').trim().length > 0;

      if (hasLead) workable.push(candidate);
      else report.noLead += 1;
    }

    if (DRY_RUN) {
      console.log('');
      console.log('DRY RUN');
      console.log(`  would reprocess: ${workable.length}`);
      console.log(`  no lead:         ${report.noLead} (no company and no URL to start from)`);
      console.log('');
      console.log('Re-run without --dry-run to process these.');
      return;
    }

    /* One row at a time, enqueue then immediately drain. Sequential on purpose:
       these are paid external calls, and a single in-flight job is also what keeps
       this from competing with the API's own worker for the same claims. */
    for (const [index, candidate] of workable.entries()) {
      const label = `${candidate.company ?? '(no company)'} — ${candidate.role ?? '(no role)'}`;

      try {
        const enqueued = await enqueueDiscoveryJob({
          jobId: candidate.id,
          company: candidate.company,
          role: candidate.role,
          location: candidate.location,
          employmentType: candidate.employmentType,
          batch: candidate.batch,
          sourceUrl: candidate.sourceUrl,
          initialApplyUrl: candidate.applyUrl,
          initialCandidates: null,
        });

        if (enqueued.outcome === 'queued') report.queuedNew += 1;
        else if (enqueued.outcome === 'updated') report.requeued += 1;
        else {
          /* `duplicate` means the row was deliberately left alone — already
             verified, or a worker holds the claim. Draining here would claim some
             other job's row and bill it to this one. */
          report.skippedExisting += 1;
          continue;
        }
      } catch (error: unknown) {
        report.enqueueErrors += 1;
        logger.warn(
          `[reprocess] could not queue jobId=${candidate.id} -> ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      /* Claims and processes the oldest claimable row, which is not necessarily
         the one just enqueued — the API's worker may be running against the same
         queue. That is fine and is why the costs below are read back by `jobId`
         rather than assumed: every claim drains one row of the same backlog, and
         the totals stay honest either way. */
      const result = await processNextDiscoveryJob();
      report.processed += 1;

      switch (result.outcome) {
        case 'completed':
          report.newlyVerified += 1;
          break;
        case 'not_found':
          report.stillUnverified += 1;
          break;
        case 'failed':
          report.failed += 1;
          break;
        case 'retry_scheduled':
          report.retryScheduled += 1;
          break;
        case 'idle':
          /* Another worker drained the row first. Not an error, and not a
             processed row either — undo the increment so the count means what it
             says. */
          report.processed -= 1;
          break;
      }

      const costs = await readCosts(candidate.id);
      if (costs.firecrawl) report.firecrawlCalls += 1;
      if (costs.webSearch) report.webSearchCalls += 1;
      report.externalApiCalls += costs.calls;

      logger.info(
        `[reprocess] ${index + 1}/${workable.length} ${result.outcome} ` +
          `verified=${String(costs.verified)} ${label}`,
      );
    }

    console.log('');
    console.log('REPROCESS REPORT');
    console.log(`  selected:          ${report.selected} (unverified, active, in window)`);
    console.log(`  processed:         ${report.processed}`);
    console.log(`  newly verified:    ${report.newlyVerified} (now visible with an Apply button)`);
    console.log(`  still unverified:  ${report.stillUnverified} (stored, hidden, retryable)`);
    console.log(`  failed:            ${report.failed} (retry budget exhausted)`);
    console.log(`  retry scheduled:   ${report.retryScheduled} (left to the running worker)`);
    console.log(
      `  duplicate:         ${report.requeued} (existing discovery row reused, no second row created)`,
    );
    console.log(
      `  left as-is:        ${report.skippedExisting} (already verified, or a worker holds the claim)`,
    );
    console.log(`  no lead:           ${report.noLead} (no company and no URL to start from)`);
    console.log(`  new queue rows:    ${report.queuedNew}`);
    console.log(`  enqueue errors:    ${report.enqueueErrors}`);
    console.log('');
    console.log('EXTERNAL CALLS');
    console.log(`  Firecrawl:   ${report.firecrawlCalls} job(s) used it`);
    console.log(`  Web Search:  ${report.webSearchCalls} job(s) used it`);
    console.log(`  total calls: ${report.externalApiCalls}`);

    if (report.newlyVerified > 0) {
      console.log('');
      console.log(
        `${report.newlyVerified} job(s) now have a verified apply URL and an Apply button. ` +
          'Clients already on the page were told over Socket.IO as each one verified.',
      );
    }
  } finally {
    await disconnectDatabase();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[reprocess] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
