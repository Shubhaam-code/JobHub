/**
 * Facts drawn out of the jobs actually in the feed.
 *
 * The reference homepage shows a row of company logos and a "Popular searches"
 * line. Both are real here rather than a fixed list: the companies are the ones
 * currently hiring in this database, and the search terms are the words that
 * actually appear most in those postings — so every chip is a query that returns
 * something, and neither row claims a partnership or a trend that does not exist.
 */
import type { PublicJob } from "@/lib/api";
import { jobLogoUrl } from "@/lib/job-display";

export interface CompanyTally {
  name: string;
  count: number;
}

/**
 * A logo is a brand-level decoration, not a reason to merge job entities. Keep
 * the tally grouping deliberately conservative, but let common legal/entity
 * suffixes and well-known brand spellings share an already-stored logo.
 */
const COMPANY_LOGO_ALIASES = new Map<string, string>([
  ["amazoncom", "amazon"],
  ["deloitteus", "deloitte"],
  ["deloitteindia", "deloitte"],
  ["eurofinsanalyticalservices", "eurofins"],
]);

const LEGAL_SUFFIXES = new Set([
  "ag",
  "bv",
  "co",
  "company",
  "corp",
  "corporation",
  "gmbh",
  "inc",
  "incorporated",
  "limited",
  "llc",
  "llp",
  "ltd",
  "plc",
  "private",
  "pvt",
  "sa",
]);

function companyLogoKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1) ?? "")) words.pop();

  const compact = words.join("");
  return COMPANY_LOGO_ALIASES.get(compact) ?? compact;
}

/**
 * Finds a job carrying the best logo for a company tally. The returned job is
 * also the fallback source for the shared monogram when no logo exists.
 */
export function companyLogoJob(
  jobs: readonly PublicJob[],
  companyName: string,
): PublicJob | null {
  const key = companyLogoKey(companyName);
  let fallback: PublicJob | null = null;

  for (const job of jobs) {
    const company = job.company?.trim();
    if (!company || companyLogoKey(company) !== key) continue;

    fallback ??= job;
    if (jobLogoUrl(job) !== null) return job;
  }

  return fallback;
}

/**
 * The companies with the most open postings, most first.
 *
 * Grouped case-insensitively (the same employer arrives spelled several ways from
 * different messages) while keeping the spelling that appeared most often.
 */
export function topCompanies(jobs: readonly PublicJob[], limit: number): CompanyTally[] {
  const groups = new Map<string, Map<string, number>>();

  for (const job of jobs) {
    const name = job.company?.trim();
    if (!name) continue;

    const key = name.toLowerCase();
    const spellings = groups.get(key) ?? new Map<string, number>();
    spellings.set(name, (spellings.get(name) ?? 0) + 1);
    groups.set(key, spellings);
  }

  const tallies: CompanyTally[] = [];

  for (const spellings of groups.values()) {
    let name = "";
    let best = 0;
    let count = 0;

    for (const [spelling, times] of spellings) {
      count += times;
      if (times > best) {
        best = times;
        name = spelling;
      }
    }

    tallies.push({ name, count });
  }

  return sortTallies(tallies).slice(0, limit);
}

/**
 * Words that turn up in role lines without narrowing anything: articles, the
 * verbs a posting is announced with, and the recruiting boilerplate that arrives
 * attached to a title. "Remote", "Intern" and every technology name are
 * deliberately absent — those are exactly the searches worth offering.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "batch",
  "by",
  "campus",
  "drive",
  "for",
  "free",
  "fresher",
  "freshers",
  "from",
  "hiring",
  "in",
  "is",
  "job",
  "jobs",
  "join",
  "link",
  "multiple",
  "new",
  "now",
  "of",
  "off",
  "on",
  "opening",
  "openings",
  "opportunities",
  "opportunity",
  "or",
  "other",
  "post",
  "recruitment",
  "role",
  "roles",
  "the",
  "to",
  "urgent",
  "vacancy",
  "various",
  "with",
  "work",
  "year",
  "years",
]);

/**
 * The most common meaningful words across role titles.
 *
 * A whole role line is nearly always unique ("Backend Engineer Intern — 2026
 * batch"), so counting lines would produce a list of ones. Counting the words
 * inside them surfaces the terms people would actually type, and each one is a
 * real `search` query against the same field it was read from.
 */
export function popularSearchTerms(jobs: readonly PublicJob[], limit: number): string[] {
  const counts = new Map<string, number>();

  for (const job of jobs) {
    const role = job.role?.trim();
    if (!role) continue;

    /* Split on anything that is not part of a technology name — `+`, `#` and `.`
       stay so "c++", "c#" and "node.js" survive as single tokens. */
    const tokens = new Set(
      role
        .toLowerCase()
        .split(/[^a-z0-9+#.]+/)
        .map((token) => token.replace(/^\.+|\.+$/g, ""))
        .filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !STOP_WORDS.has(token)),
    );

    // Counted once per posting, so a title that repeats a word does not outweigh
    // a word used across many postings.
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const tallies = [...counts].map(([name, count]) => ({ name, count }));

  return sortTallies(tallies)
    .slice(0, limit)
    .map((tally) => presentTerm(tally.name));
}

/** Most postings first; ties broken alphabetically so the order is stable. */
function sortTallies(tallies: CompanyTally[]): CompanyTally[] {
  return tallies.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** Short tokens are nearly always initialisms ("sde", "qa", "ui"); the rest read as words. */
function presentTerm(token: string): string {
  if (token.length <= 3 && /^[a-z]+$/.test(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}
