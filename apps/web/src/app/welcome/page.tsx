import type { Metadata } from "next";

import { WelcomeHero } from "@/components/welcome-hero";
import { WelcomeHowItWorks } from "@/components/welcome-how-it-works";
import { WelcomeNav } from "@/components/welcome-nav";
import { fetchJobs } from "@/lib/api";

export const metadata: Metadata = {
  /* No `title` of its own: the landing page is the brand's front door, so it
     inherits the root default and the tab reads just "JobHub". */
  description:
    "JobFeed collects jobs and internships from public channels into one feed. Search by role, company or location, upload your resume once and get matched postings.",
};

/**
 * Cache window for the two counts below.
 *
 * The page is otherwise static, and a figure on a landing page does not need to be
 * accurate to the second — but it does need to be real, so it is re-read once a
 * minute rather than baked in at build time. It also means a build in an
 * environment with no API reachable still produces a page: the fetch fails, the
 * counts come back null, and the cards that would have shown them are dropped.
 */
export const revalidate = 60;

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** What the hero draws, or nulls when the API could not be reached. */
interface FeedSummary {
  totalJobs: number | null;
  weekJobs: number | null;
}

/**
 * Two reads, both for their `pagination.total` — one over the whole feed, one
 * windowed to the last seven days. `limit: 1` because no posting itself is needed
 * here: the hero draws counts, and those come from the pagination block rather than
 * from counting rows.
 *
 * `allSettled`, not `all`: the windowed count failing should not also cost the page
 * its total, and neither failing should cost it the page.
 */
async function readFeedSummary(): Promise<FeedSummary> {
  const since = new Date(Date.now() - WEEK_MS).toISOString();

  const [all, week] = await Promise.allSettled([
    fetchJobs({ page: 1, limit: 1, sort: "newest" }),
    fetchJobs({ page: 1, limit: 1, postedFrom: since }),
  ]);

  return {
    totalJobs: all.status === "fulfilled" ? all.value.pagination.total : null,
    weekJobs: week.status === "fulfilled" ? week.value.pagination.total : null,
  };
}

/**
 * The landing page — the first screen anyone opening the site sees.
 *
 * Public by design: `proxy.ts` lists `/welcome` among its public prefixes, so it
 * renders with or without a session, and it is where signing out returns to. Its
 * job is to introduce the product and hand off to `/sign-in`, which links on to
 * `/sign-up`; after either, the existing flow takes the visitor to the feed.
 *
 * It sits outside the `(app)` route group on purpose. That group's layout supplies
 * `SiteHeader`, whose nav is the signed-in app's — Recommended and Dashboard are
 * both gated — so this page draws its own bar instead and owns its own `<main>`.
 */
export default async function WelcomePage() {
  const { totalJobs, weekJobs } = await readFeedSummary();

  return (
    <>
      <WelcomeNav />
      <main id="main" className="flex-1">
        <WelcomeHero totalJobs={totalJobs} weekJobs={weekJobs} />
        <WelcomeHowItWorks />
      </main>
    </>
  );
}
