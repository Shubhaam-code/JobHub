/**
 * Read-only audit of stored apply links. Writes nothing, ever.
 *
 *   npm run jobs:audit-urls --workspace @jia/api
 *
 * Answers the questions a fix has to be designed against: how many listings carry
 * a link at all, which external hosts those links point at, when the bad ones were
 * created, which channel produced them, and how many are shorteners or redirect
 * wrappers that hide their real destination.
 *
 * `cleanedText` is audited alongside `applyUrl` because the description is rendered
 * with its links live (see `apps/web/src/lib/links.ts#linkifyText`), so an
 * aggregator URL in the body is just as clickable as one in the apply field.
 *
 * Only projections are read and no update, delete or insert is issued from this
 * file — it is safe to run against production.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobModel } from '../models/job.model.js';
import { classifyApplyUrl, hostOfUrl } from '../apply-url/classify.js';
import { URL_REGEX } from '../telegram/text-safety.js';

interface AuditRow {
  _id: unknown;
  applyUrl: string | null;
  company?: string | null;
  cleanedText?: string | null;
  telegramChannel?: string | null;
  source?: string | null;
  createdAt?: Date;
}

/** `--top=<n>` and friends. */
function numericFlag(name: string, fallback: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (raw === undefined) return fallback;
  const value = Number(raw.slice(name.length + 3));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

const TOP = numericFlag('top', 40);

function increment(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

/** Descending by count, then by key so equal counts print in a stable order. */
function ranked(counter: Map<string, number>): [string, number][] {
  return [...counter.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function table(title: string, rows: [string, number][], limit = Number.POSITIVE_INFINITY): void {
  console.log('');
  console.log(title);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const shown = rows.slice(0, limit);
  const width = Math.max(...shown.map(([key]) => key.length));
  for (const [key, count] of shown) {
    console.log(`  ${key.padEnd(width)}  ${String(count).padStart(6)}`);
  }
  if (rows.length > shown.length) {
    console.log(`  … and ${rows.length - shown.length} more`);
  }
}

function monthOf(date: Date | undefined): string {
  if (date === undefined) return '(unknown)';
  return `${String(date.getUTCFullYear())}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main(): Promise<void> {
  logger.info(`[url-audit] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — the audit needs a working database.');
  }

  const total = await JobModel.countDocuments({});

  const hostCounts = new Map<string, number>();
  const verdictCounts = new Map<string, number>();
  const reasonCounts = new Map<string, number>();
  const badByMonth = new Map<string, number>();
  const allByMonth = new Map<string, number>();
  const badByChannel = new Map<string, number>();
  const bodyHostCounts = new Map<string, number>();

  let withUrl = 0;
  let withoutUrl = 0;
  let wrappers = 0;
  let bodyOffenders = 0;
  const samples: string[] = [];

  const cursor = JobModel.find({})
    .select({
      applyUrl: 1,
      company: 1,
      cleanedText: 1,
      telegramChannel: 1,
      source: 1,
      createdAt: 1,
    })
    .lean<AuditRow>()
    .cursor();

  try {
    for await (const row of cursor) {
      const month = monthOf(row.createdAt);
      increment(allByMonth, month);

      const url = row.applyUrl?.trim();

      if (!url) {
        withoutUrl += 1;
      } else {
        withUrl += 1;

        const verdict = classifyApplyUrl(url, { company: row.company });
        increment(verdictCounts, verdict.verdict);
        increment(reasonCounts, `${verdict.verdict}: ${verdict.reason}`);

        const host = hostOfUrl(verdict.normalizedUrl ?? url);
        increment(hostCounts, host ?? '(unparseable)');

        if (verdict.verdict === 'wrapper') wrappers += 1;

        if (verdict.verdict === 'aggregator' || verdict.verdict === 'suspicious') {
          increment(badByMonth, month);
          increment(badByChannel, `${row.source ?? '?'} / @${row.telegramChannel ?? '?'}`);
          if (samples.length < 15) samples.push(`${verdict.verdict.padEnd(10)} ${url}`);
        }
      }

      // Body links: the description renders these as live anchors.
      const body = row.cleanedText ?? '';
      let bodyHit = false;
      for (const match of body.matchAll(URL_REGEX)) {
        const found = match[0].replace(/[.,;:!?…"')\]}]+$/, '');
        const verdict = classifyApplyUrl(found, { company: row.company });
        if (verdict.verdict === 'aggregator') {
          bodyHit = true;
          increment(bodyHostCounts, hostOfUrl(found) ?? '(unparseable)');
        }
      }
      if (bodyHit) bodyOffenders += 1;
    }
  } finally {
    await cursor.close().catch(() => {});
  }

  const aggregator = verdictCounts.get('aggregator') ?? 0;
  const suspicious = verdictCounts.get('suspicious') ?? 0;

  console.log('');
  console.log('════ Apply-link audit (read-only) ════');
  console.log(`  jobs total:            ${total}`);
  console.log(`  with an apply link:    ${withUrl}`);
  console.log(`  with no apply link:    ${withoutUrl}`);
  console.log(`  aggregator verdict:    ${aggregator}`);
  console.log(`  suspicious verdict:    ${suspicious}`);
  console.log(`  shortener/wrapper:     ${wrappers} (destination unknown until resolved)`);
  console.log(`  bodies with aggregator links: ${bodyOffenders}`);

  table('Verdicts', ranked(verdictCounts));
  table(`Apply-link hosts (top ${String(TOP)})`, ranked(hostCounts), TOP);
  table('Reasons', ranked(reasonCounts), TOP);
  table('Aggregator/suspicious by month created', ranked(badByMonth));
  table('All jobs by month created', ranked(allByMonth));
  table('Aggregator/suspicious by source / channel', ranked(badByChannel), TOP);
  table('Aggregator hosts inside description bodies', ranked(bodyHostCounts), TOP);

  if (samples.length > 0) {
    console.log('');
    console.log('Sample offending apply links');
    for (const sample of samples) console.log(`  ${sample}`);
  }

  console.log('');
  await disconnectDatabase();
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[url-audit] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
