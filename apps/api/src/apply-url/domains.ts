/**
 * The domain lists every apply-link judgement is made against.
 *
 * One module, so the audit script, the ingestion pipeline, the backfill and the
 * render-layer guard can never disagree about what an aggregator is. Each list is
 * seeded here and extended from configuration (`env`), so adding a newly-observed
 * aggregator is a config change and a restart, never a code change and a deploy.
 *
 * The seed values are deliberately conservative:
 *
 *  - `SEED_AGGREGATOR_DOMAINS` starts from the one host reported plus the four the
 *    existing intermediary resolver already treats as article sites. Everything
 *    else has to be *observed* in our own data (see `jobs:audit-urls`) before it is
 *    added — guessing here would reclassify links that work today.
 *  - `SEED_TRUSTED_ATS_DOMAINS` is the recruiting-platform list from the brief.
 *    Being on it makes a URL acceptable, so it holds only platforms whose whole
 *    purpose is hosting an employer's application.
 *
 * Host matching lives in `classify.ts` and is exact-host-or-subdomain on the
 * WHATWG-parsed hostname, which is what makes these plain strings safe: no regex
 * to be bypassed by a scheme, a `www.`, a case change, an added subdomain, a
 * trailing dot or a `user@host` prefix.
 */

import { env } from '../config/env.js';

/**
 * Sites that publish an article *about* a job instead of hosting the application.
 *
 * A link to one of these is never a valid apply link: the candidate lands on a
 * competitor's page and has to find an apply button all over again, and the link
 * dies whenever that page is edited or unpublished.
 */
export const SEED_AGGREGATOR_DOMAINS: readonly string[] = [
  // Reported.
  'freshershunt.in',
  // Already treated as article sites by the existing intermediary resolver.
  'job4freshers.co.in',
  'offcampusjobs4u.com',
  'freshersvoice.com',
  'freshercareers.in',
  // Observed in our own data by `jobs:audit-urls` (2026-09-03): each of these
  // stored links is an article page on a job-posting site, not an application.
  'placementdrive.in',
  'fresheroffcampus.com',
  'kickcharm.com',
  'offcampusjobdrives.com',
  'jobs4fresher.com',
  'careerten.com',
];

/** ATS and recruiting platforms. A URL on one of these is a real application. */
export const SEED_TRUSTED_ATS_DOMAINS: readonly string[] = [
  'myworkdayjobs.com',
  'workdayjobs.com',
  'workday.com',
  'taleo.net',
  'successfactors.com',
  'successfactors.eu',
  'oraclecloud.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'smartrecruiters.com',
  'icims.com',
  'jobvite.com',
  'darwinbox.in',
  'darwinbox.com',
  'zohorecruit.com',
  'zohorecruit.in',
  'keka.com',
  'freshteam.com',
  'joinsuperset.com',
  'eightfold.ai',
  'phenompeople.com',
  'avature.net',
  'brassring.com',
  'peoplestrong.com',
  'hirist.tech',
];

/**
 * Hosts whose entire purpose is serving a form, so any path on them is one.
 *
 * `forms.gle/aB3xY9` has no `/forms/` segment to look for — the host *is* the
 * form service. Requiring a path here would reject every short form link.
 */
export const SEED_FORM_ONLY_HOSTS: readonly string[] = [
  'forms.gle',
  'forms.office.com',
  'forms.microsoft.com',
  'forms.cloud.microsoft',
  'typeform.com',
  'zohoforms.com',
  'forms.zohopublic.in',
  'forms.zohopublic.com',
];

/**
 * Hosts that serve forms *and* much else. A form path is required, because the
 * bare host is Google Docs or an Airtable base, not an application.
 */
export const SEED_FORM_PATH_HOSTS: readonly string[] = ['docs.google.com', 'airtable.com'];

/**
 * Job boards: real places to apply, but not the employer and not an ATS.
 *
 * Deliberately `suspicious` rather than `direct` or `aggregator`. A LinkedIn
 * posting is a genuine application route, so rejecting it would throw away a
 * working link; but it is a third party that can delist the post, and it is not
 * the employer's own destination, so it is not something to publish unreviewed.
 * A human promotes these one click at a time.
 */
export const SEED_JOB_BOARD_DOMAINS: readonly string[] = [
  'linkedin.com',
  'indeed.com',
  'indeed.co.in',
  'naukri.com',
  'glassdoor.com',
  'glassdoor.co.in',
  'monsterindia.com',
  'foundit.in',
  'shine.com',
  'timesjobs.com',
  'internshala.com',
  'angel.co',
  'wellfound.com',
];

/**
 * Link shorteners and redirect wrappers.
 *
 * Not wrong, but not yet knowable: the verdict for one of these is `wrapper`,
 * meaning "resolve it, then classify the destination". Storing one unresolved is
 * what lets an aggregator link hide behind a respectable-looking host.
 */
export const SEED_WRAPPER_DOMAINS: readonly string[] = [
  'bit.ly',
  'bitly.com',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'rb.gy',
  'is.gd',
  'buff.ly',
  'lnkd.in',
  'l.facebook.com',
  'lm.facebook.com',
  'l.instagram.com',
  'href.li',
  'urlz.fr',
  's.id',
  'linktr.ee',
  'openinapp.co',
  // Observed in our own data by `jobs:audit-urls` (2026-09-03).
  // @placementdriveofficial's own shortener. A wrapper rather than an aggregator
  // on purpose: the destination behind it is often a real employer page, so it is
  // worth one request to find out instead of being rejected on sight.
  'pdlink.in',
  'pdlinks.in',
  // Affiliate redirect networks. The destination decides the verdict.
  'imp.i384100.net',
  'go.acciojob.com',
  'link.outskill.com',
];

/**
 * Our own frontends. An apply link pointing back at us is a loop, not an
 * application — the candidate arrives where they started.
 */
export const SEED_OWN_DOMAINS: readonly string[] = [
  'localhost',
  'job-hub-web-ochre.vercel.app',
  'jobhub-jubu-web.onrender.com',
  'jobhub-jubu-api.onrender.com',
];

/**
 * Host fragments that mark an aggregator without naming one.
 *
 * Advisory only: a match makes a URL `suspicious`, which routes it to the human
 * review queue. It is never enough to reject a link on its own, because these
 * words also appear in legitimate employer and government hostnames
 * (`placement.iitk.ac.in`), and a false positive here would break a working link.
 */
export const SUSPICIOUS_HOST_FRAGMENTS: readonly string[] = [
  'fresher',
  'offcampus',
  'off-campus',
  'jobs4u',
  'placement',
  'govtjob',
  'sarkari',
  'careerdose',
  'alljob',
  'jobalert',
  'jobupdate',
  'jobsdrive',
  'jobhunt',
  'naukriupdate',
];

/**
 * An SEO article slug — `/cognizant-service-desk-off-campus-2026/` — rather than
 * an application endpoint. Also advisory, for the same reason.
 */
export const ARTICLE_SLUG_REGEX =
  /\/(?:[^/?#]+[-_])?(?:off[-_]?campus|walk[-_]?in|recruitment|recruiting|hiring|campus[-_]?drive|placement[-_]?drive|job[-_]?opening|mega[-_]?drive)(?:[-_][^/?#]*)?(?:\/|$)/i;

/** Deduplicated, lowercased union of a seed list and its configured extension. */
function merge(seed: readonly string[], configured: readonly string[]): readonly string[] {
  return [...new Set([...seed, ...configured].map((entry) => entry.toLowerCase()))];
}

export const AGGREGATOR_DOMAINS = merge(SEED_AGGREGATOR_DOMAINS, [
  // The intermediary resolver's own configured list describes the same sites, so
  // a host added there is an aggregator here too rather than only there.
  ...env.intermediaryJobSites,
  ...env.applyUrlAggregatorDomains,
]);

export const TRUSTED_ATS_DOMAINS = merge(SEED_TRUSTED_ATS_DOMAINS, env.applyUrlTrustedAtsDomains);
export const FORM_ONLY_HOSTS = merge(SEED_FORM_ONLY_HOSTS, []);
export const FORM_PATH_HOSTS = merge(SEED_FORM_PATH_HOSTS, []);
export const JOB_BOARD_DOMAINS = merge(SEED_JOB_BOARD_DOMAINS, []);
export const WRAPPER_DOMAINS = merge(SEED_WRAPPER_DOMAINS, env.applyUrlWrapperDomains);
export const OWN_DOMAINS = merge(SEED_OWN_DOMAINS, env.applyUrlOwnDomains);
