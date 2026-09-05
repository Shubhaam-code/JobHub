/* eslint-disable no-useless-escape */

/**
 * Daily import of the public Summer-2027-SWE-Internships README.
 *
 * The README is the source of truth for this feed. This module only maps its
 * Markdown rows into the existing `jobs` collection; it does not create a
 * second job model or a GitHub-specific API/UI.
 */

import { createHash } from 'node:crypto';

import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { normalizeApplyUrl } from '../apply-url/classify.js';
import {
  JOB_ACTIVE_WINDOW_MS,
  JOB_SOURCE_ACTIVE_WINDOW_DAYS,
  JobModel,
} from '../models/job.model.js';
import { resolveApplyUrlFields } from '../models/job.repository.js';
import { findStoredCompanyLogoUrl } from '../models/job.model.js';
import { findCompanyLogoUrl } from '../telegram/company-logo.js';
import { broadcastNewJob, getSocketServer } from '../lib/socket.js';
import { broadcastJobUpdateById } from '../lib/job-broadcast.js';
import { enqueueDiscoveryJob } from '../apply-discovery/queue.js';
import { formatJob, type MongoJobDoc } from '../routes/jobs.route.js';

export const GITHUB_SOURCE = 'github:Chieler/Summer-2027-SWE-Internships';
export const GITHUB_CHANNEL = 'github-summer-2027-swe-internships';
export const GITHUB_ACTIVE_WINDOW_DAYS = 21;

export interface GithubJobRow {
  company: string;
  role: string;
  location?: string | null;
  postedAt: Date | null;
  applyUrl: string | null;
  raw: string;
}

export interface GithubReadmeParseResult {
  fetched: number;
  rows: GithubJobRow[];
  skipped: number;
  hasJobTable: boolean;
}

export interface GithubSyncSummary {
  fetched: number;
  parsed: number;
  created: number;
  updated: number;
  skipped: number;
  expired: number;
}

const LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/i;
const HTML_LINK_RE = /<a\b[^>]*\bhref=["'](https?:\/\/[^"']+)["'][^>]*>/i;
const RAW_LINK_RE = /https?:\/\/[^\s<>]+/i;
const DATE_RE = /^(\d{4})[-/]([01]?\d)[-/]([0-3]?\d)(?:[T\s].*)?$/;
const DATE_TEXT_RE = /^(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})$/;

function splitTableRow(line: string): string[] | null {
  const text = line.trim();
  if (!text.includes('|')) return null;
  const cells = text.split('|').map((cell) => cell.trim());
  if (text.startsWith('|')) cells.shift();
  if (text.endsWith('|')) cells.pop();
  return cells.length >= 3 ? cells : null;
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, '')));
}

function cleanCell(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[\u2000-\u206f]/g, '')
    .replace(/[\u2700-\u27bf]/g, '')
    .replace(/[\ufe00-\ufe0f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isMissingCell(value: string): boolean {
  return !value || /^[-n\/a]+$/i.test(value) || /[\u2013\u2014]/.test(value);
}

function parsePostedDate(value: string | undefined): Date | null {
  const text = value?.trim() ?? '';
  if (isMissingCell(text)) return null;
  if (!text || /^[-—–n\/a]+$/i.test(text)) return null;

  const iso = DATE_RE.exec(text);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
      ? date
      : null;
  }

  if (!DATE_TEXT_RE.test(text)) return null;
  const parsed = new Date(text + ' UTC');
  return Number.isNaN(parsed.getTime())
    ? null
    : new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

function parseApplyUrl(value: string | undefined): string | null {
  const text = value?.trim() ?? '';
  if (!text || text === '-' || text === '—' || text === 'â€”') return null;
  return text.match(LINK_RE)?.[1] ?? (text.startsWith('http://') || text.startsWith('https://') ? text : null);
}

function parseApplyUrlSafe(value: string | undefined): string | null {
  const text = value?.trim() ?? '';
  if (isMissingCell(text)) return null;
  if (!text || /^[-—–n\/a]+$/i.test(text)) return null;
  const legacy = parseApplyUrl(value);
  const candidate =
    text.match(LINK_RE)?.[1] ??
    text.match(HTML_LINK_RE)?.[1] ??
    text.match(RAW_LINK_RE)?.[0] ??
    legacy;
  if (!candidate) return null;
  try {
    const url = new URL(candidate.replace(/[),.;!?]+$/g, ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function headerValue(
  cells: readonly string[],
  headers: ReadonlyMap<string, number>,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    const index = headers.get(alias);
    if (index !== undefined) return cells[index]?.trim() ?? '';
  }
  return '';
}

/** Parses every Company/Role/Posted/Link Markdown table in the README. */
export function parseGithubReadme(markdown: string): GithubReadmeParseResult {
  let headers: Map<string, number> | null = null;
  let fetched = 0;
  let skipped = 0;
  let hasJobTable = false;
  const rows: GithubJobRow[] = [];

  for (const line of markdown.split(/\r?\n/)) {
    const cells = splitTableRow(line);
    if (cells === null) {
      headers = null;
      continue;
    }

    const normalized = cells.map((cell) => cell.toLowerCase().replace(/[^a-z]/g, ''));
    const hasCompany = normalized.some((name) =>
      ['company', 'companyname', 'employer', 'organization', 'organisation'].includes(name),
    );
    const hasRole = normalized.some((name) =>
      ['role', 'title', 'position', 'positiontitle', 'jobtitle'].includes(name),
    );
    if (hasCompany && hasRole) {
      hasJobTable = true;
      headers = new Map(normalized.map((name, index) => [name, index]));
      continue;
    }

    if (headers === null || isSeparatorRow(cells)) continue;
    fetched += 1;

    const company = cleanCell(headerValue(cells, headers, ['company', 'companyname', 'employer']));
    const role = cleanCell(
      headerValue(cells, headers, ['role', 'title', 'position', 'positiontitle', 'jobtitle']),
    );
    const locationValue = cleanCell(
      headerValue(cells, headers, [
        'location',
        'locations',
        'city',
        'region',
        'country',
        'joblocation',
        'worklocation',
      ]),
    );
    const postedAt = parsePostedDate(
      headerValue(cells, headers, [
        'posted',
        'posteddate',
        'dateposted',
        'dateadded',
        'added',
        'addeddate',
        'dateofposting',
        'published',
        'publisheddate',
        'date',
      ]),
    );
    const applyUrl = parseApplyUrlSafe(
      headerValue(cells, headers, [
        'link',
        'apply',
        'applylink',
        'application',
        'applicationlink',
        'applicationurl',
        'applyurl',
        'url',
      ]),
    );

    // Keep malformed rows in the fetched count, but never let one poison the
    // rest of the import. A missing posted date is retained as a parsed row and
    // is deliberately skipped by sync because it cannot satisfy the feed rule.
    if (!company || !role) {
      skipped += 1;
      continue;
    }
    rows.push({ company, role, location: locationValue || null, postedAt, applyUrl, raw: line.trim() });
  }

  return { fetched, rows, skipped, hasJobTable };
}

export function sourceIdFor(row: GithubJobRow): string {
  const normalizedUrl = normalizeApplyUrl(row.applyUrl) ?? row.applyUrl?.trim().toLowerCase() ?? '';
  // A source can legitimately reuse one ATS URL for multiple roles (for example
  // a "multiple teams" posting). Include the extracted entity fields so those
  // remain distinct while exact duplicate rows in the README stay idempotent.
  const company = row.company.trim().toLowerCase().replace(/\s+/g, ' ');
  const role = row.role.trim().toLowerCase().replace(/\s+/g, ' ');
  const identity = `${normalizedUrl}|${company}|${role}`;
  return `github:${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`;
}

function telegramMessageIdFor(sourceId: string): number {
  const hex = createHash('sha256').update(sourceId).digest('hex').slice(0, 8);
  const value = Number.parseInt(hex, 16) % 2_000_000_000;
  return value === 0 ? 1 : value;
}

export function githubSourceCutoff(now: Date): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  today.setUTCDate(today.getUTCDate() - GITHUB_ACTIVE_WINDOW_DAYS);
  return today;
}

function legacyStatusCutoff(now: Date): Date {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  today.setUTCDate(today.getUTCDate() - JOB_SOURCE_ACTIVE_WINDOW_DAYS);
  return today;
}

function loggerRef(row: GithubJobRow): string {
  return `[github ${row.company} / ${row.role}]`;
}

async function logoForCompany(
  company: string,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const key = company.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const stored = await findStoredCompanyLogoUrl(company).catch(() => null);
    const logo = await findCompanyLogoUrl(company, { storedLogoUrl: stored });
    cache.set(key, logo);
    return logo;
  } catch (error: unknown) {
    logger.debug(`[github-sync] logo lookup failed for ${company} -> ${error instanceof Error ? error.message : String(error)}`);
    cache.set(key, null);
    return null;
  }
}

/** Fetches, parses and idempotently upserts the GitHub jobs into `jobs`. */
interface GithubReadmeCacheEntry {
  markdown: string;
  etag: string | null;
  lastModified: string | null;
  fetchedAt: number;
}

const readmeCache = new Map<string, GithubReadmeCacheEntry>();

export function clearGithubReadmeCache(): void {
  readmeCache.clear();
}

export async function syncGithubJobs(
  options: { fetchImpl?: typeof fetch; now?: Date; readmeUrl?: string } = {},
): Promise<GithubSyncSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? new Date();
  const readmeUrl = options.readmeUrl ?? env.GITHUB_JOBS_REPOSITORY_URL;

  logger.info(`[github-sync] SYNC START url=${readmeUrl}`);

  let response: Response;
  let markdown: string;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.GITHUB_JOBS_SYNC_TIMEOUT_MS);
  try {
    const cached = readmeCache.get(readmeUrl);
    const headers: Record<string, string> = {
      Accept: 'text/plain',
      'User-Agent': 'jobhub-github-sync',
    };
    if (cached?.etag) headers['If-None-Match'] = cached.etag;
    if (cached?.lastModified) headers['If-Modified-Since'] = cached.lastModified;

    response = await fetchImpl(readmeUrl, {
      headers,
      signal: controller.signal,
    });
    if (response.status === 304 && cached) {
      markdown = cached.markdown;
    } else {
      markdown = await response.text();
      if (response.ok) {
        readmeCache.set(readmeUrl, {
          markdown,
          etag: response.headers?.get?.('etag') ?? null,
          lastModified: response.headers?.get?.('last-modified') ?? null,
          fetchedAt: Date.now(),
        });
      }
    }
  } catch (error: unknown) {
    clearTimeout(timeout);
    logger.error(`[github-sync] GitHub unavailable -> ${error instanceof Error ? error.message : String(error)}`);
    logger.info('[github-sync] SYNC COMPLETE fetched=0 parsed=0 new=0 updated=0 skipped=0 expired=0');
    return { fetched: 0, parsed: 0, created: 0, updated: 0, skipped: 0, expired: 0 };
  }
  clearTimeout(timeout);

  if (response.status !== 304 && !response.ok) {
    logger.error(`[github-sync] GitHub returned ${response.status} ${response.statusText}`);
    logger.info('[github-sync] SYNC COMPLETE fetched=0 parsed=0 new=0 updated=0 skipped=0 expired=0');
    return { fetched: 0, parsed: 0, created: 0, updated: 0, skipped: 0, expired: 0 };
  }

  const parsed = parseGithubReadme(markdown);
  const summary: GithubSyncSummary = {
    fetched: parsed.fetched,
    parsed: parsed.rows.length,
    created: 0,
    updated: 0,
    skipped: parsed.skipped,
    expired: 0,
  };

  // A successful HTTP response can still be an error page or a README whose
  // table format changed. Do not interpret that as an authoritative empty feed
  // and expire every previously imported role.
  if (!parsed.hasJobTable) {
    logger.warn('[github-sync] No recognizable jobs table found; preserving existing GitHub rows');
    logger.info(
      `[github-sync] SYNC COMPLETE fetched=${summary.fetched} parsed=${summary.parsed} new=0 updated=0 skipped=${summary.skipped} expired=0`,
    );
    return summary;
  }

  const cutoff = githubSourceCutoff(now);
  const statusCutoff = legacyStatusCutoff(now);
  const seen = new Set<string>();
  const logos = new Map<string, string | null>();

  logger.info(`[github-sync] Fetched: ${summary.fetched}, Parsed: ${summary.parsed}`);

  for (const row of parsed.rows) {
    const sourceId = sourceIdFor(row);
    if (seen.has(sourceId)) {
      summary.skipped += 1;
      continue;
    }

    if (row.postedAt === null) {
      summary.skipped += 1;
      logger.warn(`${loggerRef(row)} skipped -> missing or malformed posted date`);
      continue;
    }
    // Only a row with a usable source date is authoritative for this refresh.
    // Leaving malformed rows out of `seen` lets reconciliation hide an older
    // record for the same identity instead of keeping stale data active.
    seen.add(sourceId);

    try {
      const apply = resolveApplyUrlFields(row.applyUrl, { company: row.company });
      const active = row.postedAt >= cutoff;
      const logo = await logoForCompany(row.company, logos);
      
      // GitHub jobs with valid apply URLs are considered verified since they come
      // from a curated public repository. `verified` is the status the classifier
      // actually produces for a `direct` link — see `apply-url/status.ts`.
      const applyUrlVerified = apply.applyUrl !== null && apply.applyUrlStatus === 'verified';
      
      const fields = {
        company: row.company,
        role: row.role,
        batch: null,
        applyUrl: apply.applyUrl,
        applyUrlStatus: apply.applyUrlStatus,
        applyUrlCheckedAt: apply.applyUrlCheckedAt,
        applyUrlVerified,
        applyUrlDiscoveryMethod: applyUrlVerified ? 'github-source' : null,
        applyUrlVerificationEvidence: applyUrlVerified 
          ? { officialSource: true, applicationAction: true, companyMatch: true, activeJob: active }
          : null,
        sourceUrl: apply.sourceUrl,
        applyUrlCandidates: apply.applyUrlCandidates,
        location: row.location ?? null,
        employmentType: 'internship',
        companyLogoUrl: logo,
        source: GITHUB_SOURCE,
        sourceId,
        telegramChannel: GITHUB_CHANNEL,
        telegramChannelId: null,
        telegramMessageId: telegramMessageIdFor(sourceId),
        telegramMessageUrl: 'https://github.com/Chieler/Summer-2027-SWE-Internships/blob/main/README.md',
        originalText: row.raw,
        cleanedText: `${row.role} at ${row.company}`,
        postedAt: row.postedAt,
        // The public rule is based on the source date, not import time. Keep
        // the legacy lifecycle guard comfortably ahead so it cannot hide a
        // source posting that is still inside the existing public window. Refreshing
        // this value also lets a corrected source date reactivate an existing
        // historical row without changing its original createdAt.
        expiresAt: new Date(now.getTime() + JOB_ACTIVE_WINDOW_MS),
        // Keep the existing Jobs lifecycle status stable while the dedicated
        // GitHub feed gets its requested 21-day source-date marker.
        status: row.postedAt >= statusCutoff ? 'active' : 'expired',
        githubFeedActive: active,
      } as const;

      let existing = await JobModel.findOne({ source: GITHUB_SOURCE, sourceId })
        .select({ _id: 1 })
        .lean();
      /* A title/location edit should update the existing listing when its
         application URL and company still identify the same source row. */
      if (existing === null && apply.applyUrl !== null) {
        existing = await JobModel.findOne({
          source: GITHUB_SOURCE,
          company: row.company,
          applyUrl: apply.applyUrl,
        })
          .select({ _id: 1 })
          .lean();
      }
      if (existing === null && apply.applyUrl !== null) {
        existing = await JobModel.findOne({
          source: GITHUB_SOURCE,
          applyUrl: apply.applyUrl,
        })
          .select({ _id: 1 })
          .lean();
      }
      let jobId: unknown;

      if (existing === null) {
        const created = await JobModel.create(fields);
        jobId = created._id;
        summary.created += 1;
        if (active && getSocketServer() !== null) {
          /* On the Global Internships channel, never `job:new`. The `/jobs`
             listeners prepend whatever arrives on that event, so broadcasting here
             put a card into a feed whose own query excludes this source. */
          broadcastNewJob(
            formatJob(created.toObject() as unknown as MongoJobDoc),
            'global-internships',
          );
        }
      } else {
        jobId = existing._id;
        const result = await JobModel.updateOne({ _id: existing._id }, { $set: fields });
        if (result.modifiedCount > 0) summary.updated += 1;
        if (!active && result.modifiedCount > 0) summary.expired += 1;
        if (active && result.modifiedCount > 0) await broadcastJobUpdateById(existing._id);
      }

      /* This source writes through `JobModel` rather than `saveJob()`, so the
         discovery enqueue that lives in the repository does not happen here. A
         README row usually carries a good ATS link and verifies on its own; when it
         does not, the row would otherwise stay unverified forever and never appear
         in the feed. Only unverified rows are enqueued, and only active ones —
         spending discovery on an expired posting helps nobody. */
      if (!applyUrlVerified && active && env.APPLY_DISCOVERY_ENABLED) {
        /* Never fatal to the row: this sync also runs as a standalone CLI, and a
           queue write that fails should cost the row its Apply button, not its
           import. */
        try {
          await enqueueDiscoveryJob({
            jobId: String(jobId),
            company: row.company,
            role: row.role,
            location: row.location ?? null,
            employmentType: 'internship',
            batch: null,
            sourceUrl: apply.sourceUrl,
            initialApplyUrl: row.applyUrl,
            initialCandidates: apply.applyUrlCandidates,
          });
        } catch (error: unknown) {
          logger.warn(
            `${loggerRef(row)} apply discovery not queued -> ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (!active && existing === null) summary.expired += 1;
    } catch (error: unknown) {
      summary.skipped += 1;
      logger.warn(`${loggerRef(row)} skipped -> ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // A successful README refresh is authoritative: a role removed from it is
  // retained for history but hidden from the feed instead of being deleted.
  let existingSourceJobs: { _id: unknown; sourceId?: string; status?: string }[];
  try {
    existingSourceJobs = await JobModel.find({ source: GITHUB_SOURCE })
      .select({ _id: 1, sourceId: 1, status: 1 })
      .lean<{ _id: unknown; sourceId?: string; status?: string }[]>();
  } catch (error: unknown) {
    logger.error(
      `[github-sync] Could not reconcile removed rows -> ${error instanceof Error ? error.message : String(error)}`,
    );
    logger.info(
      `[github-sync] SYNC COMPLETE fetched=${summary.fetched} parsed=${summary.parsed} new=${summary.created} updated=${summary.updated} skipped=${summary.skipped} expired=${summary.expired}`,
    );
    return summary;
  }
  for (const job of existingSourceJobs) {
    if (!job.sourceId || seen.has(job.sourceId)) continue;
    const result = await JobModel.updateOne(
      { _id: job._id },
      { $set: { status: 'expired', githubFeedActive: false } },
    );
    if (result.modifiedCount > 0) summary.expired += 1;
  }

  logger.info(
    `[github-sync] New: ${summary.created}, Updated: ${summary.updated}, Skipped: ${summary.skipped}, Expired: ${summary.expired}`,
  );
  logger.info(
    `[github-sync] SYNC COMPLETE fetched=${summary.fetched} parsed=${summary.parsed} new=${summary.created} updated=${summary.updated} skipped=${summary.skipped} expired=${summary.expired}`,
  );
  return summary;
}

export interface GithubSyncScheduler {
  stop(): void;
}

/** Starts the boot sync plus one refresh per configured interval. */
export function startGithubSyncScheduler(): GithubSyncScheduler | null {
  if (!env.GITHUB_JOBS_SYNC_ENABLED) {
    logger.info('[github-sync] disabled by GITHUB_JOBS_SYNC_ENABLED=false');
    return null;
  }

  void syncGithubJobs().catch((error: unknown) => {
    logger.error(`[github-sync] sync failed -> ${error instanceof Error ? error.message : String(error)}`);
  });

  const timer = setInterval(() => {
    void syncGithubJobs().catch((error: unknown) => {
      logger.error(`[github-sync] scheduled sync failed -> ${error instanceof Error ? error.message : String(error)}`);
    });
  }, env.GITHUB_JOBS_SYNC_INTERVAL_MS);
  timer.unref?.();

  return { stop: () => clearInterval(timer) };
}
