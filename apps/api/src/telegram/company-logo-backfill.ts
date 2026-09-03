/**
 * One-time population of `companyLogoUrl` on jobs stored before logo resolution
 * existed.
 *
 * The live pipeline resolves a logo in the queue worker, so every job stored from
 * now on already carries one when its company has a findable logo. Jobs stored
 * earlier have the field missing entirely. This module walks those rows and puts
 * them in the same state a fresh ingestion would have produced.
 *
 * Deliberately narrow, because it writes to a populated collection:
 *
 *  - It calls `resolveCompanyLogo` — the same function the worker calls — so a
 *    backfilled row is indistinguishable from a freshly ingested one. There is no
 *    second copy of the name-cleaning, domain-guessing or verification logic.
 *  - A row that already has a logo is skipped without a request. Nothing is ever
 *    overwritten.
 *  - The only field it can write is `companyLogoUrl`. The extracted fields
 *    (`company`, `role`, `batch`, `applyUrl`, `location`, `employmentType`),
 *    provenance (`telegramChannel`, `telegramMessageId`, `telegramMessageUrl`,
 *    `originalText`, `cleanedText`, `postedAt`) and the lifecycle fields are
 *    never touched, and no document is ever deleted or merged — deduplication is
 *    the unique `(telegramChannel, telegramMessageId)` index and is not this
 *    script's job.
 *  - A company whose logo cannot be verified leaves its row exactly as it was.
 *
 * Idempotent by construction: a populated row is skipped by the same check that
 * selected it, so re-running is a no-op. Interrupting a run is safe too — each
 * row is its own single-field update, so there is no partial state to repair.
 *
 * Rows are consumed from an `AsyncIterable` so the caller can stream a MongoDB
 * cursor: memory stays flat regardless of collection size.
 */

import { logger } from '../lib/logger.js';
import { JobModel } from '../models/job.model.js';
import {
  companyLogoCacheKey,
  isLogoWorthyCompany,
  resolveCompanyLogo,
  type CompanyLogoResolution,
} from './company-logo.js';

/**
 * The only fields the backfill reads. `originalText` and `cleanedText` are
 * deliberately absent: they are the largest fields on the document and nothing
 * here needs them.
 */
export interface StoredJobLogo {
  _id: unknown;
  company?: string | null;
  companyLogoUrl?: string | null;
  telegramChannel?: string | null;
  telegramMessageId?: number | null;
}

export interface CompanyLogoBackfillSummary {
  /** Rows read from the database. */
  examined: number;
  /** Of those, the ones missing a logo and carrying a usable company name. */
  candidates: number;
  /** Rows that already had a logo: skipped, nothing written, no request made. */
  skippedHasLogo: number;
  /** Rows with no company name, or a placeholder one ("Confidential", "MNC"). */
  skippedNoCompany: number;
  /** Rows whose `companyLogoUrl` was filled in. */
  updated: number;
  /** Candidates whose company yielded no verified logo. Left unchanged. */
  notFound: number;
  /** Rows that threw, e.g. the update failed. Left untouched. */
  errors: number;
  /** Distinct companies looked up — the number of provider requests made. */
  companiesResolved: number;
  /** True when no write was performed. */
  dryRun: boolean;
}

export interface CompanyLogoBackfillOptions {
  /** Rows to consider, in any order. Streamed, never buffered. */
  jobs: AsyncIterable<StoredJobLogo> | Iterable<StoredJobLogo>;
  /** Report only; nothing is written. */
  dryRun?: boolean;
  /** Pause between provider lookups, in ms. Only applied after a real lookup. */
  pauseMs?: number;
  /** Stop after this many candidates. 0 = no cap. */
  limit?: number;
  /** Logo resolver. Overridden only in tests. */
  resolve?: (company: string) => Promise<CompanyLogoResolution>;
  /** Persistence hook. Overridden only in tests. */
  saveLogoUrl?: (job: StoredJobLogo, companyLogoUrl: string) => Promise<void>;
}

/** Log label for a row: the Telegram coordinates when present, else the id. */
function jobRef(job: StoredJobLogo): string {
  if (job.telegramChannel && typeof job.telegramMessageId === 'number') {
    return `[@${job.telegramChannel} msg ${job.telegramMessageId}]`;
  }
  return `[job ${String(job._id)}]`;
}

/**
 * Writes the single field this script owns.
 *
 * The filter also requires the logo to still be absent, so a row the queue worker
 * populated between the read and the write is left alone rather than overwritten
 * from a stale read.
 *
 * `updateOne` with `$set` also bypasses the model's `pre('save')` hook, so
 * `expiresAt` — and therefore which jobs the feed shows — cannot shift as a side
 * effect of adding a logo.
 */
async function saveLogoUrlToDatabase(
  job: StoredJobLogo,
  companyLogoUrl: string,
): Promise<void> {
  await JobModel.updateOne(
    { _id: job._id, companyLogoUrl: { $in: [null, ''] } },
    { $set: { companyLogoUrl } },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** True when the row already has a logo worth keeping. */
function hasLogo(job: StoredJobLogo): boolean {
  return (job.companyLogoUrl?.trim().length ?? 0) > 0;
}

/**
 * Fills in `companyLogoUrl` on every stored job that is missing one.
 *
 * Never throws: a row that fails only increments `errors`, so one unreachable
 * provider request cannot end a run partway through the collection.
 */
export async function runCompanyLogoBackfill(
  options: CompanyLogoBackfillOptions,
): Promise<CompanyLogoBackfillSummary> {
  const dryRun = options.dryRun ?? false;
  const pauseMs = options.pauseMs ?? 0;
  const limit = options.limit ?? 0;
  const resolve = options.resolve ?? ((company: string) => resolveCompanyLogo(company));
  const saveLogoUrl = options.saveLogoUrl ?? saveLogoUrlToDatabase;

  const summary: CompanyLogoBackfillSummary = {
    examined: 0,
    candidates: 0,
    skippedHasLogo: 0,
    skippedNoCompany: 0,
    updated: 0,
    notFound: 0,
    errors: 0,
    companiesResolved: 0,
    dryRun,
  };

  /**
   * Companies already looked up during this run, and what they yielded.
   *
   * The resolver has its own process-wide cache, but a dry run must report the
   * same numbers a real run would, and this is also what makes
   * `companiesResolved` an honest count of requests rather than of rows.
   */
  const seenCompanies = new Map<string, string | null>();

  for await (const job of options.jobs) {
    summary.examined += 1;

    // Rule: never overwrite. A row with a logo is done, whatever its name is.
    if (hasLogo(job)) {
      summary.skippedHasLogo += 1;
      continue;
    }

    const company = job.company?.trim() ?? '';

    // No name, or a placeholder one — there is nothing to look a logo up by, and
    // guessing from "Confidential" would show the wrong company's mark.
    if (!isLogoWorthyCompany(company)) {
      summary.skippedNoCompany += 1;
      continue;
    }

    if (limit > 0 && summary.candidates >= limit) {
      logger.info(`[logo-backfill] Candidate limit of ${limit} reached — stopping.`);
      break;
    }

    summary.candidates += 1;
    const ref = jobRef(job);
    const key = companyLogoCacheKey(company);

    try {
      let logoUrl: string | null;
      let looked = false;

      if (seenCompanies.has(key)) {
        logoUrl = seenCompanies.get(key) ?? null;
      } else {
        const resolution = await resolve(company);
        logoUrl = resolution.url;
        looked = true;
        seenCompanies.set(key, logoUrl);
        summary.companiesResolved += 1;

        if (logoUrl === null) {
          logger.debug(
            `[logo-backfill] ${company} → no logo (${resolution.reason ?? 'not found'})`,
          );
        }
      }

      if (logoUrl === null) {
        // Left exactly as it was: null here means the card keeps its monogram.
        summary.notFound += 1;
        if (looked && pauseMs > 0) await sleep(pauseMs);
        continue;
      }

      if (!dryRun) {
        await saveLogoUrl(job, logoUrl);
      }

      summary.updated += 1;
      logger.info(
        `[logo-backfill] ${ref} ${dryRun ? 'would set' : 'set'} companyLogoUrl for ${company}\n` +
          `    to ${logoUrl}`,
      );

      // Only after a real lookup, so the pause throttles the provider rather than
      // the scan: a run over many jobs for one company is not slowed at all.
      if (looked && pauseMs > 0) await sleep(pauseMs);
    } catch (error: unknown) {
      summary.errors += 1;
      logger.error(
        `[logo-backfill] ${ref} failed → ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return summary;
}
