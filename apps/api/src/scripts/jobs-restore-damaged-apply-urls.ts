/**
 * One-time repair for stored `applyUrl` values the current rules reject.
 *
 *   npm run jobs:restore-urls --workspace @jia/api -- --dry-run
 *   npm run jobs:restore-urls --workspace @jia/api
 *
 * Two classes of bad link have reached the database:
 *
 *   1. A malformed host with no dot (`http://job4freshers/`), written by an early
 *      backfill run before the resolver rejected such hosts.
 *   2. A promotion link — a channel's Linktree, a recruiter's LinkedIn profile —
 *      accepted before link-in-bio pages counted as promotion.
 *
 * Neither is recoverable from the stored URL, but neither needs to be: the repair
 * re-derives the link from `originalText`, the untouched Telegram post, using
 * `extractApplyUrl` — the same function ingestion uses, so this script cannot
 * disagree with the live pipeline about which link in a post is the apply link.
 * A row whose post offers nothing valid has `applyUrl` cleared, because a wrong
 * apply button is worse than none.
 *
 * Only `applyUrl` is written, via `$set`, so no other field moves — including
 * `expiresAt`, which a `save()` would re-stamp. After this, `jobs:fix-apply-urls`
 * resolves any restored aggregator link to its real destination.
 */

import { connectDatabase, disconnectDatabase, redactUri } from '../config/database.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { JobModel } from '../models/job.model.js';
import { extractApplyUrl } from '../telegram/normalize.js';
import { isPromotionalUrl } from '../telegram/text-safety.js';

const DRY_RUN = process.argv.includes('--dry-run');

interface StoredUrl {
  _id: unknown;
  applyUrl: string;
  telegramChannel?: string;
  telegramMessageId?: number;
}

/**
 * Why a stored URL is unusable, or null when it is fine.
 *
 * Judged on the stored value alone — never on whether a better one exists — so a
 * healthy row can never be selected for rewriting.
 */
function rejectionReason(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'not a URL';
  }

  // No dot means no public site: a malformed href from a page's own theme.
  if (!host.includes('.')) return 'malformed host';
  if (isPromotionalUrl(url)) return 'promotion link';

  return null;
}

async function main(): Promise<void> {
  logger.info(`[url-restore] Connecting to MongoDB at ${redactUri(env.MONGODB_URI)}...`);

  if (!(await connectDatabase())) {
    throw new Error('MongoDB connection failed — the repair needs a working database.');
  }

  // Two passes on purpose: `originalText` is the largest field on a job, so it is
  // read only for the handful of rows that turn out to need repairing.
  const stored = await JobModel.find({ applyUrl: { $nin: [null, ''] } })
    .select({ applyUrl: 1, telegramChannel: 1, telegramMessageId: 1 })
    .lean<StoredUrl[]>();

  const damaged = stored
    .map((row) => ({ row, reason: rejectionReason(row.applyUrl) }))
    .filter((entry): entry is { row: StoredUrl; reason: string } => entry.reason !== null);

  logger.info(
    `[url-restore] Scanned ${stored.length} job(s) with an apply URL — ${damaged.length} unusable` +
      (DRY_RUN ? ' — DRY RUN, nothing will be written.' : '.'),
  );

  let restored = 0;
  let cleared = 0;

  for (const { row, reason } of damaged) {
    const where = `@${row.telegramChannel ?? '?'} ${row.telegramMessageId ?? '?'}`;
    const job = await JobModel.findById(row._id).select({ originalText: 1 }).lean<{ originalText?: string }>();
    const posted = extractApplyUrl(job?.originalText ?? '');

    if (!DRY_RUN) {
      // Guarded on the bad value, so a row someone else has since corrected is
      // left alone rather than overwritten.
      await JobModel.updateOne({ _id: row._id, applyUrl: row.applyUrl }, { $set: { applyUrl: posted } });
    }

    if (posted === null) {
      cleared += 1;
      console.log(`  ${DRY_RUN ? 'would clear  ' : 'cleared      '} ${where}  (${reason})  ${row.applyUrl}`);
    } else {
      restored += 1;
      console.log(`  ${DRY_RUN ? 'would restore' : 'restored     '} ${where}  (${reason})\n      ${row.applyUrl}\n   -> ${posted}`);
    }
  }

  console.log('');
  console.log(`Apply URL repair${DRY_RUN ? ' (DRY RUN — nothing written)' : ''}:`);
  console.log(`  unusable:  ${damaged.length}`);
  console.log(`  ${DRY_RUN ? 'would restore:' : 'restored:     '} ${restored} (link recovered from the post)`);
  console.log(`  ${DRY_RUN ? 'would clear:  ' : 'cleared:      '} ${cleared} (the post holds no valid link)`);

  if (damaged.length > 0) {
    console.log('');
    console.log(
      DRY_RUN
        ? 'Re-run without --dry-run to apply, then run jobs:fix-apply-urls to resolve them.'
        : 'Now run: npm run jobs:fix-apply-urls --workspace @jia/api',
    );
  }

  await disconnectDatabase();
}

try {
  await main();
  process.exit(0);
} catch (error) {
  logger.error(`[url-restore] Fatal error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
