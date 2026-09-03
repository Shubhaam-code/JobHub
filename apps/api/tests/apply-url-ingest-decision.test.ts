/**
 * The ingest decision: one posted URL in, the apply fields a job is stored with out.
 *
 * This is the file that encodes the behaviour change the whole feature exists for.
 * The resolver this replaces promised "resolution can improve a link but never lose
 * one", so every failure fell back to storing the aggregator URL — and that fallback
 * *was* the defect. The tests below pin the new contract instead:
 *
 *   the apply field holds a link classified `direct`, or it holds nothing.
 *
 * An unreadable page, an ambiguous candidate set and a shortener that will not
 * resolve therefore all assert `applyUrl === null` — with the article kept as
 * `sourceUrl` so a human still has the lead.
 *
 * `fetch` is injected, so nothing here touches the network.
 */

import { describe, expect, it, vi } from 'vitest';

import { decideIngestApplyUrl } from '../src/apply-url/ingest-decision.js';

const ARTICLE_URL = 'https://freshershunt.in/cognizant-off-campus-drive-2026';
const WORKDAY_URL =
  'https://cognizant.wd1.myworkdayjobs.com/en-US/Cognizant_Careers/job/R-12345';

const PROSE = `
  <p>Cognizant is conducting an off campus drive for the 2026 batch. Eligible
  candidates from BE, BTech, ME, MTech, MCA and MSc streams can apply online
  through the official link given at the end of this article. Read the eligibility
  criteria and the selection process carefully before applying.</p>
`;

/** An article whose body links to the employer's ATS and nothing else usable. */
const CLEAN_ARTICLE = `<article>${PROSE}<a href="${WORKDAY_URL}">Apply Now</a></article>`;

/**
 * A fetch stub built from URL → response *factories*.
 *
 * Factories rather than instances because one URL is fetched twice in the wrapper
 * cases — once to follow the redirect, once to read the page — and a `Response`
 * body can only be consumed once.
 */
function fetchFrom(map: Record<string, () => Response>): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const factory = map[url];
    if (factory === undefined) return Promise.reject(new Error(`unexpected fetch: ${url}`));
    return Promise.resolve(factory());
  }) as unknown as typeof fetch;
}

const html = (body: string) => (): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });

const redirectTo = (location: string) => (): Response =>
  new Response(null, { status: 302, headers: { location } });

describe('decideIngestApplyUrl — a link that needs no help', () => {
  it('stores an employer ATS link untouched, without a request', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const decision = await decideIngestApplyUrl(
      { postedUrl: WORKDAY_URL, company: 'Cognizant' },
      { fetchImpl },
    );

    expect(decision.applyUrl).toBe(WORKDAY_URL);
    expect(decision.sourceUrl).toBeNull();
    expect(decision.candidates).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stores nothing when the post carried no URL', async () => {
    const decision = await decideIngestApplyUrl({ postedUrl: null, company: 'Acme' });

    expect(decision.applyUrl).toBeNull();
    expect(decision.sourceUrl).toBeNull();
    expect(decision.candidates).toBeNull();
    expect(decision.reason).toBe('no URL');
  });

  it('stores nothing for a URL that is not usable at all', async () => {
    const decision = await decideIngestApplyUrl({ postedUrl: 'javascript:alert(1)' });

    expect(decision.applyUrl).toBeNull();
    expect(decision.reason).toMatch(/not a usable http/i);
  });
});

describe('decideIngestApplyUrl — an aggregator article', () => {
  it('opens the article and stores the employer link found inside it', async () => {
    const decision = await decideIngestApplyUrl(
      { postedUrl: ARTICLE_URL, company: 'Cognizant' },
      { fetchImpl: fetchFrom({ [ARTICLE_URL]: html(CLEAN_ARTICLE) }) },
    );

    expect(decision.applyUrl).toBe(WORKDAY_URL);
    // The article stays as provenance: it is where the link came from.
    expect(decision.sourceUrl).toBe(ARTICLE_URL);
    expect(decision.candidates).toBeNull();
    expect(decision.reason).toMatch(/resolved from the aggregator page/);
  });

  it('stores nothing when the article cannot be read', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('socket hang up')),
    ) as unknown as typeof fetch;

    const decision = await decideIngestApplyUrl(
      { postedUrl: ARTICLE_URL, company: 'Cognizant' },
      { fetchImpl },
    );

    // The old resolver stored the aggregator URL here. That is the bug.
    expect(decision.applyUrl).toBeNull();
    expect(decision.sourceUrl).toBe(ARTICLE_URL);
    expect(decision.reason).toMatch(/aggregator page unreadable/);
  });

  it('stores nothing when the article has no apply candidate', async () => {
    const decision = await decideIngestApplyUrl(
      { postedUrl: ARTICLE_URL, company: 'Cognizant' },
      {
        fetchImpl: fetchFrom({
          [ARTICLE_URL]: html(`<article>${PROSE}<a href="https://t.me/freshershunt">Apply</a></article>`),
        }),
      },
    );

    expect(decision.applyUrl).toBeNull();
    expect(decision.sourceUrl).toBe(ARTICLE_URL);
    expect(decision.candidates).toBeNull();
    expect(decision.reason).toBe('aggregator page had no apply candidate');
  });

  it('hands an ambiguous page to a human instead of picking a favourite', async () => {
    // Two equally plausible ATS links: one point apart at most, so neither wins.
    const ambiguous = `<article>${PROSE}
      <a href="${WORKDAY_URL}">Apply Now</a>
      <a href="https://cognizant.taleo.net/careersection/jobdetail?jobid=99">Apply Here</a>
    </article>`;

    const decision = await decideIngestApplyUrl(
      { postedUrl: ARTICLE_URL, company: 'Cognizant' },
      { fetchImpl: fetchFrom({ [ARTICLE_URL]: html(ambiguous) }) },
    );

    expect(decision.applyUrl).toBeNull();
    expect(decision.sourceUrl).toBe(ARTICLE_URL);
    expect(decision.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(decision.reason).toMatch(/none conclusive/);
  });

  it('refuses a winning candidate that does not classify as direct', async () => {
    /* Scoring highly is not the same as being storable: this host matches the
       company and has an apply path, but "placement" in the hostname is exactly
       the shape of an aggregator, so the classifier has the last word. */
    const suspicious = `<article>${PROSE}
      <a href="https://acme-placement.example.com/careers/apply">Apply Now</a>
    </article>`;

    const decision = await decideIngestApplyUrl(
      { postedUrl: ARTICLE_URL, company: 'Acme' },
      { fetchImpl: fetchFrom({ [ARTICLE_URL]: html(suspicious) }) },
    );

    expect(decision.applyUrl).toBeNull();
    expect(decision.reason).toMatch(/best candidate is suspicious/);
    expect(decision.candidates?.length).toBe(1);
  });

  it('leaves the page unopened when page resolution is switched off', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const decision = await decideIngestApplyUrl(
      { postedUrl: ARTICLE_URL, company: 'Cognizant' },
      { fetchImpl, resolveAggregatorPages: false },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decision.applyUrl).toBeNull();
    expect(decision.sourceUrl).toBe(ARTICLE_URL);
    expect(decision.candidates?.[0]?.url).toBe(ARTICLE_URL);
  });
});

describe('decideIngestApplyUrl — shorteners', () => {
  it('follows a shortener and stores the ATS link it lands on', async () => {
    const decision = await decideIngestApplyUrl(
      { postedUrl: 'https://bit.ly/3xYzAbc', company: 'Cognizant' },
      {
        fetchImpl: fetchFrom({
          'https://bit.ly/3xYzAbc': redirectTo(WORKDAY_URL),
          [WORKDAY_URL]: html('<html><body>ok</body></html>'),
        }),
      },
    );

    expect(decision.applyUrl).toBe(WORKDAY_URL);
    expect(decision.sourceUrl).toBeNull();
  });

  it('follows a shortener into an aggregator and keeps digging', async () => {
    const decision = await decideIngestApplyUrl(
      { postedUrl: 'https://pdlink.in/AbCd12', company: 'Cognizant' },
      {
        fetchImpl: fetchFrom({
          'https://pdlink.in/AbCd12': redirectTo(ARTICLE_URL),
          [ARTICLE_URL]: html(CLEAN_ARTICLE),
        }),
      },
    );

    expect(decision.applyUrl).toBe(WORKDAY_URL);
    expect(decision.sourceUrl).toBe(ARTICLE_URL);
  });

  it('stores nothing for a shortener that will not resolve', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.reject(new Error('ENOTFOUND')),
    ) as unknown as typeof fetch;

    const decision = await decideIngestApplyUrl(
      { postedUrl: 'https://bit.ly/3xYzAbc' },
      { fetchImpl },
    );

    expect(decision.applyUrl).toBeNull();
    expect(decision.candidates?.[0]?.url).toBe('https://bit.ly/3xYzAbc');
    expect(decision.reason).toMatch(/unresolved redirect wrapper/i);
  });
});

describe('decideIngestApplyUrl — a link we cannot judge', () => {
  it('offers a suspicious link as a candidate rather than storing it', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const url = 'https://linkedin.com/jobs/view/4001';

    const decision = await decideIngestApplyUrl({ postedUrl: url }, { fetchImpl });

    expect(decision.applyUrl).toBeNull();
    // Not an article we know how to read, so it is not opened.
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(decision.sourceUrl).toBeNull();
    expect(decision.candidates).toEqual([
      expect.objectContaining({ url, confidence: 'low', score: 0 }),
    ]);
  });
});
