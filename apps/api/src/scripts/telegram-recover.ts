/**
 * Historical Telegram recovery over a chosen window, default 14 days.
 *
 *   npm run telegram:recover --workspace @jia/api -- --dry-run
 *   npm run telegram:recover --workspace @jia/api
 *   npm run telegram:recover --workspace @jia/api -- --days=14 --max-messages=3000
 *
 * Why this exists separately from `telegram:backfill`: that script is the routine
 * 7-day top-up. This is the recovery run — a wider window, a walk ceiling sized for
 * it, and a report that answers "what did we get back", including how many postings
 * ended up publicly visible versus held back for want of a verified apply link.
 *
 * Nothing here is a new pipeline. The window is walked by `runBackfill`, so every
 * message goes through the exact path a live one does — normalize → sanitize →
 * dedupe → durable queue — and is then classified and stored by the running worker.
 * Recovery adds one step on top: any recovered posting whose apply link is not
 * verified is handed to the Universal Apply Discovery queue, which is what turns a
 * hidden row into a visible one once it finds a real application URL.
 *
 * The window is measured from each message's own Telegram date, never from when
 * this script runs, so "last 14 days" means posted in the last 14 days.
 *
 * Safety, by construction rather than by care:
 *   - Nothing is deleted or overwritten. Storing is `saveJob`'s existing upsert.
 *   - Deduplication is the queue's unique message key, so a re-run reports
 *     duplicates instead of creating second copies.
 *   - Discovery is enqueued once per job (`enqueueDiscoveryJob` upserts on `jobId`)
 *     and the worker's own bounded retry/backoff applies — no loop is added here.
 *   - Only Telegram sources are touched. The GitHub / Global Internships feed has
 *     its own sync and is never read or written by this script.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { isLlmConfigured, llmModelName } from '../llm/client.js';
import { enqueueDiscoveryJob } from '../apply-discovery/queue.js';
import { GITHUB_SOURCE } from '../github/sync.js';
import { activeJobFilter, JobModel } from '../models/job.model.js';
import { getQueueCounts, type QueueCounts } from '../queue/ingest-queue.js';
import { runBackfill, type BackfillSummary } from '../telegram/backfill.js';
import type { IngestionInput, IngestionResult } from '../telegram/ingestion.js';
import { ensureConfiguredChannels } from '../telegram/channel-registry.js';
import { resolveConfiguredChannels } from '../telegram/channels.js';
import {
  createTelegramClient,
  readTelegramCredentials,
  TelegramConfigError,
} from '../telegram/client.js';

/** The window this recovery covers, in days, measured from message date. */
const DEFAULT_RECOVERY_DAYS = 14;

/**
 * Walk ceiling per channel, above `MAX_MESSAGES_WALKED`'s 7-day default.
 *
 * A 14-day window is twice the history, and these are busy channels. Sized with
 * headroom because stopping early is silent data loss dressed up as a clean run —
 * `truncated` in the per-channel report is what surfaces it when it still happens.
 */
const DEFAULT_MAX_MESSAGES = 3_000;

const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Report the window's counts and stop — no Telegram connection, no walk, and no
 * write of any kind.
 *
 * The recovery finishes long before the LLM worker has classified what it queued,
 * so the counts printed at the end of a run are a snapshot mid-drain. This is how
 * the same numbers are read again once the queue is empty, without re-walking
 * history to get them.
 *
 * Strictly read-only, because a flag named "report" that also enqueues discovery
 * work is a flag nobody can reason about. Re-queueing the hidden rows is
 * `apply-discovery:reprocess`, which reports what it queued and what came back.
 */
const REPORT_ONLY = process.argv.includes('--report-only');

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

interface ChannelRun {
  username: string;
  summary: BackfillSummary;
}

/** What the recovery did to the `jobs` collection, as counts. */
interface RecoveryCounts {
  /** Telegram rows inside the window before the walk. */
  before: number;
  /** Telegram rows inside the window after the queue drained. */
  after: number;
  /** after − before. */
  recovered: number;
  /** Rows inside the window whose apply link is verified. */
  verified: number;
  /** Verified *and* passing the public active filter, i.e. live on `/jobs`. */
  visible: number;
  /** Rows inside the window still waiting on a verified apply link. */
  unverified: number;
}

/**
 * Rows from Telegram (and any other normal source) posted inside the window.
 *
 * `$ne: GITHUB_SOURCE` rather than `source: 'telegram'`: the report should describe
 * the `/jobs` population, which is every normal source. Global Internships are
 * excluded here for the same reason the feed excludes them — they are a different
 * feed with its own page, and counting them would overstate what this run achieved.
 */
function windowFilter(cutoff: Date): Record<string, unknown> {
  return {
    source: { $ne: GITHUB_SOURCE },
    postedAt: { $gte: cutoff },
  };
}

async function countWindow(cutoff: Date): Promise<{ total: number; verified: number; visible: number }> {
  const base = windowFilter(cutoff);

  const [total, verified, visible] = await Promise.all([
    JobModel.countDocuments(base),
    JobModel.countDocuments({ ...base, applyUrlVerified: true }),
    /* What a reader would actually see: the feed's own active clauses, plus the
       verified link the card needs for an Apply button. Composed from
       `activeJobFilter()` rather than restated, so this number cannot drift from
       the route's definition of visible. */
    JobModel.countDocuments({
      $and: [base, activeJobFilter(), { applyUrlVerified: true }],
    }),
  ]);

  return { total, verified, visible };
}

/**
 * Queues apply discovery for recovered rows that have no verified link yet.
 *
 * This is the `Verified Apply URL? → NO → keep as pending` arm of the flow. The row
 * is already stored and already excluded from the Apply button by
 * `applyUrlVerified: false`; this is what gives it a route back to visible without
 * anyone re-running the recovery.
 *
 * Only rows with something to work from are queued — a company name to match a
 * careers domain against, or a URL to start from. A row with neither would spend a
 * worker slot to conclude it had nothing to go on.
 */
async function queueDiscoveryForWindow(cutoff: Date): Promise<{
  queued: number;
  requeued: number;
  noLead: number;
  errors: number;
}> {
  const result = { queued: 0, requeued: 0, noLead: 0, errors: 0 };

  const cursor = JobModel.find({
    $and: [windowFilter(cutoff), activeJobFilter(), { applyUrlVerified: { $ne: true } }],
  })
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
    .lean<{
      _id: unknown;
      company?: string | null;
      role?: string | null;
      location?: string | null;
      employmentType?: string | null;
      batch?: string | null;
      applyUrl?: string | null;
      sourceUrl?: string | null;
    }>()
    .cursor();

  try {
    for await (const job of cursor) {
      const hasLead =
        (job.company ?? '').trim().length > 0 ||
        (job.applyUrl ?? '').trim().length > 0 ||
        (job.sourceUrl ?? '').trim().length > 0;

      if (!hasLead) {
        result.noLead += 1;
        continue;
      }

      try {
        const outcome = await enqueueDiscoveryJob({
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

        if (outcome.outcome === 'queued') result.queued += 1;
        else result.requeued += 1;
      } catch (error: unknown) {
        result.errors += 1;
        logger.warn(
          `[recover] could not queue discovery for jobId=${String(job._id)} -> ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } finally {
    await cursor.close().catch(() => {});
  }

  return result;
}

function printQueue(label: string, queue: QueueCounts): void {
  console.log(
    `${label}: pending=${queue.pending} processing=${queue.processing} ` +
      `retry_wait=${queue.retry_wait} completed=${queue.completed} failed=${queue.failed}`,
  );
}

async function main(): Promise<void> {
  const windowDays = numericFlag('days', DEFAULT_RECOVERY_DAYS, 1, 90);
  const maxMessages = numericFlag('max-messages', DEFAULT_MAX_MESSAGES, 100, 50_000);

  // `--report-only` reads the database and never opens Telegram, so it must not
  // require credentials it will not use.
  if (!REPORT_ONLY) {
    readTelegramCredentials();

    if (!env.TELEGRAM_SESSION) {
      throw new TelegramConfigError(
        'TELEGRAM_SESSION is not set. Run `npm run telegram:login --workspace @jia/api` first, ' +
          'then put the printed session string in apps/api/.env.',
      );
    }
  }

  /* A recovery run without a classifier fills the queue and stops there: no message
     becomes a job until a key is set. Worth saying plainly, because the summary
     would otherwise read as "recovered 0" and look like the walk failed. */
  if (!REPORT_ONLY) {
    if (!isLlmConfigured()) {
      logger.warn(
        '[recover] GEMINI_API_KEY is not set — messages will be queued but nothing will be ' +
          'classified or stored until it is, so the recovered count will read 0.',
      );
    } else {
      logger.info(`[recover] Classifier model: ${llmModelName()}`);
    }
  }

  logger.info(`[recover] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — recovery needs a working database.');
  }

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const before = await countWindow(cutoff);
  const queueBefore = await getQueueCounts();

  if (REPORT_ONLY) {
    try {
      console.log('');
      console.log(`Window: posted on or after ${cutoff.toISOString()} (${windowDays} days)`);
      printQueue('  ingest queue', queueBefore);
      console.log('');
      console.log('JOBS IN WINDOW');
      console.log(`  total stored:           ${before.total}`);
      console.log(`  apply URLs verified:    ${before.verified}`);
      console.log(`  visible on /jobs:       ${before.visible}`);
      console.log(`  hidden (unverified):    ${before.total - before.verified}`);

      if (before.total > before.verified) {
        console.log('');
        console.log(
          'To give the hidden rows another discovery attempt: ' +
            'npm run apply-discovery:reprocess --workspace @jia/api',
        );
      }
    } finally {
      await disconnectDatabase();
    }
    return;
  }

  console.log('');
  console.log(
    `Recovering Telegram history posted on or after ${cutoff.toISOString()} ` +
      `(${windowDays} days)${DRY_RUN ? ' — DRY RUN, nothing is queued or stored' : ''}.`,
  );
  console.log(`Jobs already stored in that window: ${before.total}`);

  await ensureConfiguredChannels();

  const handle = createTelegramClient();
  handle.client.floodSleepThreshold = 0;

  const runs: ChannelRun[] = [];

  try {
    await handle.client.connect();

    if (!(await handle.client.isUserAuthorized())) {
      throw new Error('Telegram session is not authorized. Run `npm run telegram:login` again.');
    }

    const { resolved, failed } = await resolveConfiguredChannels(handle.client);

    if (resolved.length === 0) {
      throw new Error('None of the configured channels could be resolved.');
    }

    for (const channel of resolved) {
      logger.info(`[recover] @${channel.username}: walking ${windowDays} days...`);

      try {
        const summary = await runBackfill({
          client: handle.client,
          entity: channel.entity,
          channelUsername: channel.username,
          channelId: channel.id.toString(),
          windowDays,
          maxMessages,
          /* Dry run still walks Telegram — that is the only way to report what is
             recoverable — but ingests nothing. `skipped` is the honest outcome for
             a message deliberately not queued. */
          ...(DRY_RUN
            ? {
                ingest: async (input: IngestionInput): Promise<IngestionResult> => ({
                  outcome: 'skipped',
                  messageId: input.messageId,
                  reason: 'dry run',
                }),
              }
            : {}),
        });

        runs.push({ username: channel.username, summary });
      } catch (error: unknown) {
        logger.warn(
          `[recover] @${channel.username}: failed — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const totals = runs.reduce(
      (acc, run) => ({
        fetched: acc.fetched + run.summary.fetched,
        eligible: acc.eligible + run.summary.eligible,
        queued: acc.queued + run.summary.queued,
        duplicates: acc.duplicates + run.summary.duplicates,
        skipped: acc.skipped + run.summary.skipped,
        errors: acc.errors + run.summary.errors,
        truncated: acc.truncated + (run.summary.truncated ? 1 : 0),
      }),
      { fetched: 0, eligible: 0, queued: 0, duplicates: 0, skipped: 0, errors: 0, truncated: 0 },
    );

    console.log('');
    console.log(`${windowDays}-day walk per channel:`);
    for (const { username, summary } of runs) {
      console.log(
        `  @${username}: fetched=${summary.fetched} inWindow=${summary.eligible} ` +
          `queued=${summary.queued} duplicates=${summary.duplicates} ` +
          `skipped=${summary.skipped} errors=${summary.errors}` +
          (summary.floodWaitSeconds ? ` floodWait=${summary.floodWaitSeconds}s` : '') +
          (summary.truncated ? ' TRUNCATED' : ''),
      );
    }

    if (failed.length > 0) {
      console.log(`Unresolved channels: ${failed.map((name) => `@${name}`).join(', ')}`);
    }

    if (totals.truncated > 0) {
      console.log('');
      console.log(
        `WARNING: ${totals.truncated} channel(s) hit the ${maxMessages}-message ceiling before ` +
          `reaching the ${windowDays}-day cutoff, so part of the window was not read. ` +
          `Re-run with a larger --max-messages to cover it.`,
      );
    }

    // ── 1–4: what the walk found ────────────────────────────────────────────
    console.log('');
    console.log('WALK');
    console.log(`  1. messages in window:     ${totals.eligible} (of ${totals.fetched} read)`);
    console.log(`  4. duplicates detected:    ${totals.duplicates} (already ingested, not re-created)`);
    console.log(`     queued for ingestion:   ${totals.queued}`);
    console.log(`     skipped (not a job):    ${totals.skipped}`);
    console.log(`     errors:                 ${totals.errors}`);

    const queueAfter = await getQueueCounts();
    console.log('');
    printQueue('  ingest queue before', queueBefore);
    printQueue('  ingest queue now   ', queueAfter);

    if (DRY_RUN) {
      console.log('');
      console.log('DRY RUN — nothing was queued or stored. Re-run without --dry-run to recover.');
      return;
    }

    const pendingWork =
      queueAfter.pending + queueAfter.processing + queueAfter.retry_wait;

    if (pendingWork > 0) {
      console.log('');
      console.log(
        `${pendingWork} message(s) are still waiting on the LLM worker, which classifies and ` +
          `stores them. The counts below describe the collection right now, so they will keep ` +
          `rising as the queue drains — check again with \`npm run queue:status\`.`,
      );
    }

    // ── 5–7: what is stored, and what a reader can see ──────────────────────
    const after = await countWindow(cutoff);
    const discovery = await queueDiscoveryForWindow(cutoff);

    const counts: RecoveryCounts = {
      before: before.total,
      after: after.total,
      recovered: Math.max(0, after.total - before.total),
      verified: after.verified,
      visible: after.visible,
      unverified: after.total - after.verified,
    };

    console.log('');
    console.log('JOBS IN WINDOW');
    console.log(`  2. newly recovered:        ${counts.recovered}`);
    console.log(`  3. already stored/updated: ${counts.before} (reprocessed, not duplicated)`);
    console.log(`     total in window now:    ${counts.after}`);
    console.log(`  5. apply URLs verified:    ${counts.verified}`);
    console.log(`  6. visible on /jobs:       ${counts.visible}`);
    console.log(`  7. hidden (unverified):    ${counts.unverified}`);

    console.log('');
    console.log('APPLY DISCOVERY QUEUED FOR THE HIDDEN ROWS');
    console.log(`  newly queued:  ${discovery.queued}`);
    console.log(`  re-queued:     ${discovery.requeued} (already had a discovery row)`);
    console.log(`  no lead:       ${discovery.noLead} (no company and no URL to start from)`);
    console.log(`  errors:        ${discovery.errors}`);
    console.log('');
    console.log(
      'The running API worker drains that queue. Each job that verifies gets its Apply button ' +
        'over Socket.IO and joins /jobs; the rest stay stored and hidden, and are retried by the ' +
        "worker's existing backoff.",
    );
  } finally {
    await handle.client.disconnect().catch(() => {});
    await handle.client.destroy().catch(() => {});
    await disconnectDatabase();
  }
}

try {
  await main();
  // GramJS keeps timers and sockets alive; exit explicitly so the script ends.
  process.exit(0);
} catch (error) {
  if (error instanceof TelegramConfigError) {
    logger.error(error.message);
  } else {
    logger.error(`[recover] Fatal error: ${error instanceof Error ? error.message : error}`);
  }
  process.exit(1);
}
