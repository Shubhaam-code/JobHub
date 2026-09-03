/**
 * Repairs stored apply links. Reports by default; writes only when told to.
 *
 *   npm run jobs:fix-apply-urls --workspace @jia/api                     (dry run)
 *   npm run jobs:fix-apply-urls --workspace @jia/api -- --limit=20       (dry run, 20 rows)
 *   npm run jobs:fix-apply-urls --workspace @jia/api -- --apply
 *   npm run jobs:fix-apply-urls --workspace @jia/api -- --revert=<runId> --apply
 *
 * Flags:
 *   --apply             actually write. Without it nothing is modified, ever.
 *   --limit=<n>         stop after n examined jobs
 *   --since=<date>      only jobs created on or after this date (ISO, or YYYY-MM-DD)
 *   --host=<domain>     only jobs whose apply link is on this host or a subdomain
 *   --id=<objectId>     only this job (repeatable)
 *   --status=<s>        only jobs with this applyUrlStatus (repeatable)
 *   --concurrency=<n>   parallel page fetches, default 3, capped at 8
 *   --host-delay=<ms>   minimum gap between two fetches of the same host, default 1500
 *   --report=<path>     CSV output path, default reports/apply-urls-<runId>.csv
 *   --revert=<runId>    undo a previous run instead of scanning
 *   --bodies            also rewrite aggregator hrefs inside descriptions
 *                       (separate, higher-risk pass — see `body-rewrite.ts`)
 *
 * Two safety properties worth stating plainly, because they are the ones that make
 * this script safe to point at production:
 *
 *  - **`--dry-run` is not a flag you have to remember.** Reporting is the default and
 *    `--apply` is the opt-in. `--dry-run` is still accepted, and simply reasserts it.
 *  - **Every write is preceded by an audit row** holding the old URL, status and
 *    source URL, tagged with this run's id, so `--revert=<runId>` can put everything
 *    back — including links that were cleared.
 *
 * Jobs stream from a cursor, so memory is flat regardless of collection size.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobModel } from '../models/job.model.js';
import { newRunId } from '../models/apply-url-audit.model.js';
import {
  processJob,
  revertRun,
  type BackfillJob,
  type BackfillOutcome,
  type BackfillRowResult,
} from '../apply-url/backfill.js';
import { hostMatches, hostOfUrl } from '../apply-url/classify.js';
import { APPLY_URL_STATUSES, type ApplyUrlStatus } from '../apply-url/status.js';
import { rewriteBodies } from '../apply-url/body-rewrite.js';

// ── Arguments ────────────────────────────────────────────────────────────────

const ARGV = process.argv.slice(2);

function flag(name: string): boolean {
  return ARGV.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const prefixed = ARGV.find((argument) => argument.startsWith(`--${name}=`));
  return prefixed?.slice(name.length + 3);
}

function values(name: string): string[] {
  return ARGV.filter((argument) => argument.startsWith(`--${name}=`)).map((argument) =>
    argument.slice(name.length + 3),
  );
}

function numeric(name: string, fallback: number, max = Number.POSITIVE_INFINITY): number {
  const raw = value(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number (got "${raw}")`);
  }
  return Math.min(Math.floor(parsed), max);
}

/** Writing is opt-in. `--dry-run` is accepted and simply reasserts the default. */
const APPLY = flag('apply') && !flag('dry-run');
const LIMIT = numeric('limit', 0);
const CONCURRENCY = Math.max(1, numeric('concurrency', 3, 8));
const HOST_DELAY_MS = numeric('host-delay', 1500);
const HOST_FILTER = value('host')?.toLowerCase().replace(/^www\./, '') ?? null;
const ID_FILTER = values('id');
const REVERT_RUN_ID = value('revert') ?? null;
const REWRITE_BODIES = flag('bodies');

const SINCE = ((): Date | null => {
  const raw = value('since');
  if (raw === undefined) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--since is not a date (got "${raw}")`);
  return parsed;
})();

const STATUS_FILTER = ((): ApplyUrlStatus[] => {
  const raw = values('status');
  for (const entry of raw) {
    if (!(APPLY_URL_STATUSES as readonly string[]).includes(entry)) {
      throw new Error(`--status must be one of ${APPLY_URL_STATUSES.join(', ')} (got "${entry}")`);
    }
  }
  return raw as ApplyUrlStatus[];
})();

const RUN_ID = newRunId('fix-apply-urls');
const ACTOR = `jobs:fix-apply-urls (${process.env['USER'] ?? process.env['USERNAME'] ?? 'cli'})`;
const REPORT_PATH = resolvePath(value('report') ?? `reports/apply-urls-${RUN_ID}.csv`);

// ── Per-host politeness ──────────────────────────────────────────────────────

/**
 * Last fetch time per host, so `CONCURRENCY` parallel workers still leave
 * `HOST_DELAY_MS` between two requests to the *same* aggregator. A global sleep
 * would serialize the whole run; this only slows down repeat offenders.
 */
const lastHitAt = new Map<string, number>();

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

async function waitForHost(url: string | null): Promise<void> {
  if (url === null || HOST_DELAY_MS === 0) return;
  const host = hostOfUrl(url);
  if (host === null) return;

  const previous = lastHitAt.get(host);
  const now = Date.now();

  if (previous !== undefined) {
    const wait = previous + HOST_DELAY_MS - now;
    if (wait > 0) {
      lastHitAt.set(host, now + wait);
      await sleep(wait);
      return;
    }
  }

  lastHitAt.set(host, now);
}

// ── Retry ────────────────────────────────────────────────────────────────────

/**
 * Retries a row whose failure looks transient.
 *
 * Only `error` outcomes are retried. A `flagged` row is a *decision*, not a
 * failure — retrying it would just re-read the same page and reach the same
 * conclusion three times.
 */
async function withRetry(job: BackfillJob): Promise<BackfillRowResult> {
  let lastResult: BackfillRowResult | null = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));

    await waitForHost(job.applyUrl);
    const result = await processJob(job, { runId: RUN_ID, actor: ACTOR, apply: APPLY });

    if (result.outcome !== 'error') return result;
    lastResult = result;
  }

  return (
    lastResult ?? {
      outcome: 'error',
      oldUrl: job.applyUrl ?? null,
      newUrl: null,
      verdict: 'error',
      score: null,
      reason: 'no attempt completed',
      candidates: null,
    }
  );
}

// ── CSV ──────────────────────────────────────────────────────────────────────

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const CSV_HEADER = [
  'jobId',
  'channel',
  'messageId',
  'company',
  'createdAt',
  'outcome',
  'verdict',
  'score',
  'oldUrl',
  'newUrl',
  'written',
  'reason',
  'candidates',
].join(',');

function csvRow(job: BackfillJob, result: BackfillRowResult): string {
  return [
    String(job._id),
    job.telegramChannel ?? '',
    job.telegramMessageId ?? '',
    job.company ?? '',
    job.createdAt?.toISOString() ?? '',
    result.outcome,
    result.verdict,
    result.score ?? '',
    result.oldUrl ?? '',
    result.newUrl ?? '',
    result.written === true ? 'yes' : 'no',
    result.reason,
    (result.candidates ?? [])
      .map((candidate) => `${candidate.url} [${candidate.confidence}/${String(candidate.score)}]`)
      .join(' | '),
  ]
    .map(csvCell)
    .join(',');
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** The Mongo filter built from the flags. */
function buildFilter(): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (ID_FILTER.length > 0) filter['_id'] = { $in: ID_FILTER };
  if (SINCE !== null) filter['createdAt'] = { $gte: SINCE };
  if (STATUS_FILTER.length > 0) filter['applyUrlStatus'] = { $in: STATUS_FILTER };

  return filter;
}

async function main(): Promise<void> {
  logger.info(`[fix-apply-urls] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);
  await connectDatabase();

  try {
    if (REVERT_RUN_ID !== null) {
      logger.warn(
        `[fix-apply-urls] ${APPLY ? 'REVERTING' : 'DRY RUN — would revert'} run ${REVERT_RUN_ID}`,
      );
      const summary = await revertRun(REVERT_RUN_ID, { actor: ACTOR, apply: APPLY });
      logger.info(
        `[fix-apply-urls] revert examined=${String(summary.examined)} reverted=${String(
          summary.reverted,
        )} conflicts=${String(summary.conflicts)}`,
      );
      return;
    }

    logger.warn(
      APPLY
        ? `[fix-apply-urls] APPLYING CHANGES — runId=${RUN_ID} (revert with --revert=${RUN_ID} --apply)`
        : '[fix-apply-urls] DRY RUN — nothing will be written. Pass --apply to commit.',
    );

    const counts: Record<BackfillOutcome, number> = {
      repaired: 0,
      flagged: 0,
      unchanged: 0,
      skipped: 0,
      error: 0,
    };

    const rows: string[] = [CSV_HEADER];
    let examined = 0;
    let written = 0;
    let stop = false;

    const cursor = JobModel.find(buildFilter())
      .select({
        applyUrl: 1,
        applyUrlStatus: 1,
        sourceUrl: 1,
        company: 1,
        telegramChannel: 1,
        telegramMessageId: 1,
        createdAt: 1,
      })
      .sort({ createdAt: -1 })
      .lean()
      .cursor();

    /**
     * `CONCURRENCY` workers pulling from one cursor. Each awaits the next document
     * itself, so at most `CONCURRENCY` jobs are ever resident — the same
     * backpressure property the queue worker relies on.
     */
    async function worker(): Promise<void> {
      for (;;) {
        if (stop) return;

        const document = await cursor.next();
        if (document === null || document === undefined) return;

        const job = document as unknown as BackfillJob;

        // The host filter is applied here rather than in the query: the stored
        // value may be unnormalized, so the host has to be parsed to be compared.
        if (HOST_FILTER !== null) {
          const host = job.applyUrl === null ? null : hostOfUrl(job.applyUrl);
          if (host === null || !hostMatches(host, HOST_FILTER)) {
            counts.skipped += 1;
            continue;
          }
        }

        examined += 1;
        if (LIMIT > 0 && examined > LIMIT) {
          stop = true;
          return;
        }

        const result = await withRetry(job);
        counts[result.outcome] += 1;
        if (result.written === true) written += 1;
        rows.push(csvRow(job, result));

        if (result.outcome === 'repaired') {
          logger.info(
            `[${String(job._id)}] ${result.oldUrl ?? '(empty)'} → ${result.newUrl ?? '(empty)'} (${
              result.reason
            })`,
          );
        } else if (result.outcome === 'flagged') {
          logger.warn(`[${String(job._id)}] needs review → ${result.reason}`);
        } else if (result.outcome === 'error') {
          logger.error(`[${String(job._id)}] failed → ${result.reason}`);
        }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    await cursor.close();

    await mkdir(dirname(REPORT_PATH), { recursive: true });
    await writeFile(REPORT_PATH, `${rows.join('\n')}\n`, 'utf8');

    logger.info(
      [
        '',
        `════ ${APPLY ? 'Applied' : 'Dry run'} — runId=${RUN_ID} ════`,
        `  examined:   ${String(examined)}`,
        `  repaired:   ${String(counts.repaired)}`,
        `  flagged:    ${String(counts.flagged)}`,
        `  unchanged:  ${String(counts.unchanged)}`,
        `  skipped:    ${String(counts.skipped)}`,
        `  errors:     ${String(counts.error)}`,
        `  db writes:  ${String(written)}`,
        `  report:     ${REPORT_PATH}`,
        '',
      ].join('\n'),
    );

    if (REWRITE_BODIES) {
      const bodySummary = await rewriteBodies({ runId: RUN_ID, actor: ACTOR, apply: APPLY });
      logger.info(
        `[fix-apply-urls] bodies examined=${String(bodySummary.examined)} rewritten=${String(
          bodySummary.rewritten,
        )} flagged=${String(bodySummary.flagged)}`,
      );
    }

    if (!APPLY && (counts.repaired > 0 || counts.flagged > 0)) {
      logger.warn(
        `[fix-apply-urls] Nothing was written. Re-run with --apply to commit these ${String(
          counts.repaired + counts.flagged,
        )} changes.`,
      );
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((error: unknown) => {
  logger.error(
    `[fix-apply-urls] failed → ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
