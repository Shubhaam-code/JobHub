/**
 * The Universal Apply Link Discovery Agent, across the source shapes it has to
 * handle.
 *
 * Every case here is a *shape*, never a named website: an article that links out,
 * a careers page, an ATS posting, a deep/script-injected link, a page with no
 * application at all, an unknown host nobody has seen before. A fix that made one
 * particular site work by name would pass none of them.
 *
 * Network is injected via `fetchImpl`, so nothing here touches the internet. The
 * stub routes by URL, which also lets a case assert *which* pages were read — the
 * cost-control rules are as much a requirement as the verdict is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env.js';
import { discoverApplyUrl } from '../src/apply-discovery/universal-agent.js';
import { validateApplyUrlWithEvidence } from '../src/apply-discovery/validator.js';
import { type JobContext } from '../src/apply-discovery/types.js';

/* ── Page fixtures ───────────────────────────────────────────────────────── */

/** A real ATS posting: employer named, role named, an actual apply control. */
function atsPostingHtml(company: string, role: string, location: string): string {
  return `<!doctype html><html><head>
    <title>${role} — ${company}</title>
    <meta property="og:site_name" content="${company}">
    </head><body>
    <h1>${role}</h1>
    <p>${company} is hiring in ${location}. Accepting applications.</p>
    <button type="button">Apply for this job</button>
    <form action="/applications/submit"><input type="file" name="resume"></form>
    </body></html>`;
}

/** An employer's own careers page for one posting. */
function careersPostingHtml(company: string, role: string, location: string): string {
  return `<!doctype html><html><head>
    <title>${role} | Careers at ${company}</title>
    </head><body>
    <h1>${role}</h1>
    <p>Location: ${location}. ${company} careers.</p>
    <a href="/careers/apply/8891">Apply Now</a>
    </body></html>`;
}

/** A careers *index*: real employer, no posting and no application action. */
function careersIndexHtml(company: string): string {
  return `<!doctype html><html><head><title>Careers at ${company}</title></head>
    <body><h1>Work with us</h1>
    <p>${company} has openings across engineering and design.</p>
    <a href="/about">About us</a><a href="/contact">Contact</a>
    </body></html>`;
}

/** A posting the employer has closed. */
function closedPostingHtml(company: string, role: string): string {
  return `<!doctype html><html><head><title>${role} — ${company}</title></head>
    <body><h1>${role}</h1>
    <p>This position is closed and we are no longer accepting applications.</p>
    <button>Apply</button>
    </body></html>`;
}

/** An aggregator article: it links to the employer but is not the application. */
function articleHtml(company: string, role: string, applyHref: string): string {
  return `<!doctype html><html><head>
    <title>${company} Off Campus Drive 2026 | ${role}</title>
    </head><body>
    <h1>${company} Off Campus Drive</h1>
    <p>${company} is hiring for ${role}. Read the eligibility below.</p>
    <a href="https://t.me/somechannel">Join our Telegram</a>
    <a href="${applyHref}">Apply Now (Official Website)</a>
    </body></html>`;
}

/* ── Fetch stub ──────────────────────────────────────────────────────────── */

interface Route {
  /** Matched as a prefix of the requested URL. */
  url: string;
  html?: string;
  status?: number;
  /** Where a redirect chain ended, when it is not `url`. */
  finalUrl?: string;
  /** Firecrawl-shaped JSON, for the scrape/map/search endpoints. */
  json?: unknown;
}

/**
 * A fetch that answers only from `routes`, and records every URL it was asked for.
 *
 * An unrouted URL answers 404 rather than throwing, because that is what the
 * agent will meet in production and the pipeline has to survive it. `calls` is the
 * cost assertion: it is how a test proves Firecrawl was *not* consulted.
 */
function stubFetch(routes: Route[]): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];

  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);

    const route = routes.find((candidate) => url.startsWith(candidate.url));

    if (route === undefined) {
      return new Response('not found', { status: 404 });
    }

    if (route.json !== undefined) {
      return new Response(JSON.stringify(route.json), {
        status: route.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const response = new Response(route.html ?? '', {
      status: route.status ?? 200,
      headers: { 'content-type': 'text/html' },
    });

    /* `Response.url` is read-only and empty on a hand-built response. The
       validator reads it to judge where a link landed, so a redirect case has to
       define it explicitly. */
    Object.defineProperty(response, 'url', { value: route.finalUrl ?? url });

    return response;
  }) as unknown as typeof fetch;

  return { impl, calls };
}

/** A job context with everything absent unless the case sets it. */
function context(overrides: Partial<JobContext> = {}): JobContext {
  return {
    jobId: 'job-1',
    company: null,
    role: null,
    location: null,
    employmentType: null,
    batch: null,
    sourceUrl: null,
    initialApplyUrl: null,
    initialCandidates: null,
    ...overrides,
  };
}

/* ── Suite ───────────────────────────────────────────────────────────────── */

const originalFirecrawlKey = env.FIRECRAWL_API_KEY;

beforeEach(() => {
  // No key: the external stages report "not configured" and cost nothing, which
  // is what every case that does not explicitly test them wants.
  env.FIRECRAWL_API_KEY = undefined;
});

afterEach(() => {
  env.FIRECRAWL_API_KEY = originalFirecrawlKey;
  vi.restoreAllMocks();
});

describe('validateApplyUrlWithEvidence', () => {
  it('verifies an ATS posting that names the company, the role and an apply action', async () => {
    const url = 'https://boards.greenhouse.io/acmerobotics/jobs/4411';
    const { impl } = stubFetch([
      { url, html: atsPostingHtml('Acme Robotics', 'Software Engineer Intern', 'Bengaluru') },
    ]);

    const result = await validateApplyUrlWithEvidence(
      url,
      context({
        company: 'Acme Robotics',
        role: 'Software Engineer Intern',
        location: 'Bengaluru',
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(true);
    expect(result.evidence.officialSourceType).toBe('trusted_ats');
    expect(result.evidence.hasApplicationAction).toBe(true);
    // The stored evidence has to carry its own conclusion: an admin reads this
    // field directly, without the flags beside it.
    expect(result.evidence.summary).toMatch(/^verified: /);
  });

  it('refuses a careers index — right employer, but no posting to apply to', async () => {
    const url = 'https://careers.acmerobotics.com/';
    const { impl } = stubFetch([{ url, html: careersIndexHtml('Acme Robotics') }]);

    const result = await validateApplyUrlWithEvidence(
      url,
      context({ company: 'Acme Robotics', role: 'Software Engineer Intern' }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(false);
    expect(result.reason).toContain('no application action');
  });

  it('refuses a posting the employer has closed', async () => {
    const url = 'https://jobs.lever.co/acmerobotics/2f9';
    const { impl } = stubFetch([
      { url, html: closedPostingHtml('Acme Robotics', 'Software Engineer Intern') },
    ]);

    const result = await validateApplyUrlWithEvidence(
      url,
      context({ company: 'Acme Robotics', role: 'Software Engineer Intern' }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(false);
    expect(result.evidence.isJobActive).toBe(false);
  });

  it('refuses an aggregator URL without fetching it', async () => {
    const { impl, calls } = stubFetch([]);

    const result = await validateApplyUrlWithEvidence(
      'https://freshershunt.in/acme-off-campus-drive-2026/',
      context({ company: 'Acme Robotics' }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(false);
    // Judged from the classification alone. Reading the page could only produce a
    // more confident wrong answer, and it would cost a request.
    expect(calls).toHaveLength(0);
  });

  it('does not treat a company careers page for a different employer as verified', async () => {
    const url = 'https://careers.othercorp.com/jobs/12';
    const { impl } = stubFetch([
      { url, html: careersPostingHtml('Other Corp', 'Software Engineer Intern', 'Pune') },
    ]);

    const result = await validateApplyUrlWithEvidence(
      url,
      context({ company: 'Acme Robotics', role: 'Software Engineer Intern' }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(false);
  });

  it('records "not checked" rather than "closed" for a URL it never opened', async () => {
    const { impl } = stubFetch([]);

    const result = await validateApplyUrlWithEvidence(
      'https://freshershunt.in/acme-off-campus-drive-2026/',
      context({ company: 'Acme Robotics' }),
      { fetchImpl: impl },
    );

    /* `isJobActive: false` is a claim about the posting. Asserting it on the
       strength of never having looked would be stored on the job document and read
       by an admin as "this role is filled". */
    expect(result.evidence.isJobActive).toBe(true);
    expect(result.evidence.statusSignals).toContain('not checked');
  });
});

describe('discoverApplyUrl — source patterns', () => {
  it('1. verifies a direct ATS link carried in from ingestion, at zero external cost', async () => {
    const url = 'https://boards.greenhouse.io/acmerobotics/jobs/4411';
    const { impl } = stubFetch([
      { url, html: atsPostingHtml('Acme Robotics', 'Software Engineer Intern', 'Bengaluru') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'Software Engineer Intern',
        location: 'Bengaluru',
        initialApplyUrl: url,
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(true);
    expect(result.applyUrl).toBe(url);
    expect(result.discoveryMethod).toBe('direct_extraction');
    expect(result.costs.externalApiCalls).toBe(0);
  });

  it("2. verifies a company's own careers posting", async () => {
    const url = 'https://careers.acmerobotics.com/jobs/8891';
    const { impl } = stubFetch([
      { url, html: careersPostingHtml('Acme Robotics', 'Data Analyst Intern', 'Hyderabad') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'Data Analyst Intern',
        location: 'Hyderabad',
        initialApplyUrl: url,
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(true);
    expect(result.applyUrl).toBe(url);
  });

  it('3. never promotes the source article itself to the apply link', async () => {
    const article = 'https://freshershunt.in/acme-off-campus-drive-2026/';
    const { impl } = stubFetch([
      { url: article, html: articleHtml('Acme Robotics', 'SDE Intern', 'https://x.test/apply') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        initialApplyUrl: article,
        sourceUrl: article,
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(false);
    expect(result.applyUrl).toBeNull();
  });

  it('4. follows a candidate the aggregator page yielded, and verifies that instead', async () => {
    const article = 'https://freshershunt.in/acme-off-campus-drive-2026/';
    const apply = 'https://boards.greenhouse.io/acmerobotics/jobs/4411';

    const { impl } = stubFetch([
      { url: article, html: articleHtml('Acme Robotics', 'SDE Intern', apply) },
      { url: apply, html: atsPostingHtml('Acme Robotics', 'SDE Intern', 'Bengaluru') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        location: 'Bengaluru',
        sourceUrl: article,
        initialCandidates: [
          {
            url: apply,
            finalUrl: null,
            confidence: 'high',
            score: 7,
            reason: 'apply anchor on source page',
            label: 'Apply Now',
          },
        ],
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(true);
    expect(result.applyUrl).toBe(apply);
    // The article is provenance; the ATS posting is the destination.
    expect(result.applyUrl).not.toBe(article);
  });

  it('5. tries past a near-miss candidate instead of stopping at the top-ranked one', async () => {
    const index = 'https://careers.acmerobotics.com/';
    const posting = 'https://careers.acmerobotics.com/jobs/8891';

    const { impl } = stubFetch([
      { url: posting, html: careersPostingHtml('Acme Robotics', 'SDE Intern', 'Bengaluru') },
      // Registered second so the prefix match does not shadow the posting above.
      { url: index, html: careersIndexHtml('Acme Robotics') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        location: 'Bengaluru',
        initialCandidates: [
          // Ranked first, and wrong: the careers index has no application.
          { url: index, finalUrl: null, confidence: 'high', score: 8, reason: 'careers host', label: null },
          { url: posting, finalUrl: null, confidence: 'medium', score: 5, reason: 'job path', label: null },
        ],
      }),
      { fetchImpl: impl },
    );

    /* Validating only the single best candidate is what made this fall through to
       "needs review" — a page offering several plausible links verified none. */
    expect(result.verified).toBe(true);
    expect(result.applyUrl).toBe(posting);
  });

  it('6. reports no link, and no candidate URL, when nothing verifies', async () => {
    const { impl } = stubFetch([
      {
        url: 'https://careers.acmerobotics.com/',
        html: careersIndexHtml('Acme Robotics'),
      },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        initialApplyUrl: 'https://careers.acmerobotics.com/',
      }),
      { fetchImpl: impl },
    );

    /* The No Guessing rule. A careers index is a real page on the real employer's
       real domain, and it is still not this posting's application — so `applyUrl`
       stays null and the UI shows "Apply link not available". */
    expect(result.verified).toBe(false);
    expect(result.applyUrl).toBeNull();
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('7. handles a host it has never seen, on its own merits', async () => {
    /* Invented for this test, and matched by nothing in any domain list. The whole
       point of the design: an employer host that did not exist yesterday verifies
       on the same evidence as a known one. */
    const url = 'https://careers.zynthara-labs.example/openings/qa-intern-2027';
    const { impl } = stubFetch([
      { url, html: careersPostingHtml('Zynthara Labs', 'QA Intern', 'Remote') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Zynthara Labs',
        role: 'QA Intern',
        location: 'Remote',
        initialApplyUrl: url,
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(true);
    expect(result.applyUrl).toBe(url);
  });
});

describe('discoverApplyUrl — cost control', () => {
  it('does not reach Firecrawl when direct extraction already verified', async () => {
    env.FIRECRAWL_API_KEY = 'test-key';

    const url = 'https://boards.greenhouse.io/acmerobotics/jobs/4411';
    const { impl, calls } = stubFetch([
      { url, html: atsPostingHtml('Acme Robotics', 'SDE Intern', 'Bengaluru') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        location: 'Bengaluru',
        initialApplyUrl: url,
        sourceUrl: 'https://freshershunt.in/acme-off-campus-drive-2026/',
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(true);
    expect(result.costs.usedFirecrawl).toBe(false);
    expect(calls.some((call) => call.includes('api.firecrawl.dev'))).toBe(false);
  });

  it('skips the paid stages entirely when no Firecrawl key is configured', async () => {
    const article = 'https://freshershunt.in/acme-off-campus-drive-2026/';
    const { impl, calls } = stubFetch([
      { url: article, html: articleHtml('Acme Robotics', 'SDE Intern', 'https://x.test/apply') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        initialApplyUrl: article,
        sourceUrl: article,
      }),
      { fetchImpl: impl },
    );

    expect(result.verified).toBe(false);
    // Without a key the stages report "not configured" — they must not be counted
    // as spend, and nothing may be sent to Firecrawl.
    expect(result.costs.externalApiCalls).toBe(0);
    expect(calls.some((call) => call.includes('api.firecrawl.dev'))).toBe(false);
  });

  it('scrapes the source page and verifies a link only the rendered page had', async () => {
    env.FIRECRAWL_API_KEY = 'test-key';

    const article = 'https://freshershunt.in/acme-off-campus-drive-2026/';
    const apply = 'https://boards.greenhouse.io/acmerobotics/jobs/4411';

    const { impl, calls } = stubFetch([
      {
        url: 'https://api.firecrawl.dev/v2/scrape',
        json: {
          success: true,
          data: {
            // The link is script-injected: it is in the rendered HTML Firecrawl
            // returns, and was absent from the HTML read at ingest time.
            html: articleHtml('Acme Robotics', 'SDE Intern', apply),
            links: [apply],
          },
        },
      },
      { url: apply, html: atsPostingHtml('Acme Robotics', 'SDE Intern', 'Bengaluru') },
      { url: article, html: '<html><body><p>Loading…</p></body></html>' },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        location: 'Bengaluru',
        sourceUrl: article,
      }),
      { fetchImpl: impl, enableWebSearch: false },
    );

    expect(result.verified).toBe(true);
    expect(result.applyUrl).toBe(apply);
    expect(result.discoveryMethod).toBe('firecrawl_scrape');
    expect(result.costs.usedFirecrawl).toBe(true);
    expect(calls.some((call) => call.includes('/v2/scrape'))).toBe(true);
  });

  it('builds the web-search query from job metadata, not from the source website', async () => {
    env.FIRECRAWL_API_KEY = 'test-key';

    const apply = 'https://careers.acmerobotics.com/jobs/8891';
    let searchBody: { query?: string } = {};

    const { impl } = stubFetch([
      {
        url: 'https://api.firecrawl.dev/v2/search',
        json: { success: true, data: { web: [{ url: apply, title: 'SDE Intern', description: '' }] } },
      },
      { url: apply, html: careersPostingHtml('Acme Robotics', 'SDE Intern', 'Bengaluru') },
    ]);

    const recording = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/v2/search') && typeof init?.body === 'string') {
        searchBody = JSON.parse(init.body) as { query?: string };
      }
      return impl(input, init);
    }) as unknown as typeof fetch;

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        location: 'Bengaluru',
        batch: '2027',
      }),
      { fetchImpl: recording, enableFirecrawl: false },
    );

    expect(result.verified).toBe(true);
    expect(result.discoveryMethod).toBe('web_search');
    // Every term comes from the job row. Nothing names an aggregator or a
    // particular employer the code knows about.
    expect(searchBody.query).toContain('"Acme Robotics"');
    expect(searchBody.query).toContain('"SDE Intern"');
    expect(searchBody.query).toContain('Bengaluru');
    expect(searchBody.query).toContain('2027');
  });

  it('maps the employer site when earlier stages found the host but not the posting', async () => {
    env.FIRECRAWL_API_KEY = 'test-key';

    const index = 'https://careers.acmerobotics.com/';
    const posting = 'https://careers.acmerobotics.com/jobs/8891';

    const { impl, calls } = stubFetch([
      { url: 'https://api.firecrawl.dev/v2/map', json: { success: true, links: [{ url: posting, title: 'SDE Intern' }] } },
      { url: posting, html: careersPostingHtml('Acme Robotics', 'SDE Intern', 'Bengaluru') },
      { url: index, html: careersIndexHtml('Acme Robotics') },
    ]);

    const result = await discoverApplyUrl(
      context({
        company: 'Acme Robotics',
        role: 'SDE Intern',
        location: 'Bengaluru',
        initialApplyUrl: index,
      }),
      { fetchImpl: impl, enableWebSearch: false },
    );

    /* The stage that closes the last gap: a fetch of the careers index can only
       say "this is not the posting", never "the posting is over here". */
    expect(result.verified).toBe(true);
    expect(result.applyUrl).toBe(posting);
    expect(result.discoveryMethod).toBe('company_search');
    expect(calls.some((call) => call.includes('/v2/map'))).toBe(true);
  });
});
