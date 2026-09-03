/**
 * Finding the real apply link inside an aggregator's article page.
 *
 * The fixtures below are shaped like the pages this actually runs against: a
 * WordPress article with the employer's link in the body, surrounded by the site's
 * own navigation, its Telegram channel, an ad slot and a "similar jobs" block —
 * every one of them labelled "Apply Now". So the assertions are mostly about what
 * is *absent*: a rejected link is omitted rather than returned with a zero score,
 * because the review queue shows this list to a human and the page's own navigation
 * would bury the two links that matter.
 *
 * `extractApplyCandidates` is pure, so none of this touches the network.
 */

import { describe, expect, it } from 'vitest';

import {
  extractApplyCandidates,
  pickConfidentCandidate,
} from '../src/apply-url/candidates.js';
import { type ApplyUrlCandidate } from '../src/apply-url/status.js';

const PAGE_URL = 'https://freshershunt.in/cognizant-off-campus-drive-2026';
const WORKDAY_URL =
  'https://cognizant.wd1.myworkdayjobs.com/en-US/Cognizant_Careers/job/R-12345';
const FORM_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSc/viewform';

/** Enough prose that the `<article>` container is recognized as the body. */
const PROSE = `
  <p>Cognizant is conducting an off campus drive for the 2026 batch. Eligible
  candidates from BE, BTech, ME, MTech, MCA and MSc streams can apply online
  through the official link given at the end of this article. Read the eligibility
  criteria, selection process and salary details carefully before applying.</p>
`;

const ARTICLE_PAGE = `<!doctype html>
<html>
  <head><title>Cognizant Off Campus Drive 2026</title></head>
  <body>
    <nav>
      <a href="/jobs/latest">Latest Jobs</a>
      <a href="https://t.me/freshershunt">Join our Telegram &mdash; Apply Now</a>
    </nav>
    <article>
      ${PROSE}
      <a href="${WORKDAY_URL}">Apply Now</a>
      <a href="${FORM_URL}">Registration Link</a>
      <a href="https://cognizant.com">Official Website</a>
      <a href="https://job4freshers.co.in/tcs-off-campus-2026">Also apply for other jobs</a>
      <a href="https://googleads.g.doubleclick.net/pcs/click?adurl=${WORKDAY_URL}">Apply Now</a>
      <a href="https://sponsor.example.com/careers/apply" rel="sponsored nofollow">Apply Now</a>
      <a href="mailto:hr@cognizant.com">Email HR</a>
      <a href="/apply-online/">Apply Online</a>
    </article>
    <footer><a href="https://facebook.com/freshershunt">Facebook</a></footer>
  </body>
</html>`;

describe('extractApplyCandidates — a real aggregator article', () => {
  const candidates = extractApplyCandidates(ARTICLE_PAGE, PAGE_URL, { company: 'Cognizant' });
  const urls = candidates.map((candidate) => candidate.url);

  it('ranks the employer ATS link first', () => {
    expect(candidates[0]?.url).toBe(WORKDAY_URL);
    // ATS host + company match + a job path + the "Apply Now" label.
    expect(candidates[0]?.confidence).toBe('highest');
  });

  it('keeps the official form and the company site as lesser candidates', () => {
    expect(urls).toEqual([WORKDAY_URL, FORM_URL, 'https://cognizant.com/']);
  });

  it("drops the aggregator's own links, however they are labelled", () => {
    // `/jobs/latest` and the relative `/apply-online/` both resolve onto the page's
    // own host, which is never where an application lives.
    expect(urls.some((url) => url.includes('freshershunt.in'))).toBe(false);
  });

  it('drops the channel, the social footer and another aggregator', () => {
    expect(urls.some((url) => url.includes('t.me'))).toBe(false);
    expect(urls.some((url) => url.includes('facebook.com'))).toBe(false);
    expect(urls.some((url) => url.includes('job4freshers'))).toBe(false);
  });

  it('drops an anchor the page itself marks rel="sponsored"', () => {
    expect(urls.some((url) => url.includes('sponsor.example.com'))).toBe(false);
  });

  it('drops a mailto anchor rather than treating it as a URL', () => {
    expect(urls.some((url) => url.startsWith('mailto'))).toBe(false);
  });

  it('explains every candidate it does return', () => {
    for (const candidate of candidates) {
      expect(candidate.reason.length).toBeGreaterThan(0);
      expect(candidate.score).toBeGreaterThan(0);
    }
  });
});

describe('extractApplyCandidates — rejections that matter', () => {
  it('rejects an ad wrapper even when it carries a real ATS target', () => {
    // The ad host is checked before the `?adurl=` unwrapping, so an ad's own
    // landing page cannot be laundered into an apply link.
    const html = `<article>${PROSE}
      <a href="https://googleads.g.doubleclick.net/pcs/click?adurl=${WORKDAY_URL}">Apply Now</a>
    </article>`;

    expect(extractApplyCandidates(html, PAGE_URL, { company: 'Cognizant' })).toEqual([]);
  });

  it('ignores links outside the article body', () => {
    // A sidebar "Apply Now" for an unrelated company is exactly what article
    // narrowing exists to exclude.
    const html = `<html><body>
      <aside><a href="https://infosys.wd1.myworkdayjobs.com/en-US/careers/job/R-77">Apply Now</a></aside>
      <article>${PROSE}<a href="${WORKDAY_URL}">Apply Now</a></article>
    </body></html>`;

    const urls = extractApplyCandidates(html, PAGE_URL, { company: 'Cognizant' }).map(
      (candidate) => candidate.url,
    );

    expect(urls).toEqual([WORKDAY_URL]);
  });

  it('falls back to the whole document when no article container is marked', () => {
    // Without an article container the per-link rejections carry the weight, and
    // the employer link is still found.
    const html = `<html><body><div><a href="${WORKDAY_URL}">Apply Now</a></div></body></html>`;

    expect(
      extractApplyCandidates(html, PAGE_URL, { company: 'Cognizant' })[0]?.url,
    ).toBe(WORKDAY_URL);
  });

  it('scores a link found twice once, at its best score', () => {
    const html = `<article>${PROSE}
      <a href="${WORKDAY_URL}">read more</a>
      <a href="${WORKDAY_URL}">Apply Now</a>
    </article>`;

    const candidates = extractApplyCandidates(html, PAGE_URL, { company: 'Cognizant' });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.label).toBe('Apply Now');
  });

  it('does not score a shortener sitting in the article body', () => {
    /* A `bit.ly` link cannot be judged without resolving it, and this module is
       pure. Leaving it out is the honest answer: it reaches the review queue as
       part of the page rather than being guessed at here. */
    const html = `<article>${PROSE}<a href="https://bit.ly/3xYzAbc">Apply Now</a></article>`;

    expect(extractApplyCandidates(html, PAGE_URL, { company: 'Cognizant' })).toEqual([]);
  });

  it('does not score an employer homepage with no job path on its own', () => {
    // Without a company match, a bare front door is not the application.
    const html = `<article>${PROSE}<a href="https://example-employer.com">Apply Now</a></article>`;

    expect(extractApplyCandidates(html, PAGE_URL, { company: 'Cognizant' })).toEqual([]);
  });

  it('returns nothing for a page URL it cannot parse', () => {
    expect(extractApplyCandidates(ARTICLE_PAGE, 'not a url')).toEqual([]);
  });

  it('reads an href through nested markup and HTML entities', () => {
    const html = `<article>${PROSE}
      <a href='${WORKDAY_URL}?id=R-12345&amp;src=page'><strong>Apply</strong> Now &rarr;</a>
    </article>`;

    const candidate = extractApplyCandidates(html, PAGE_URL, { company: 'Cognizant' })[0];

    // `src` is a tracking parameter and is dropped; `id` is a job id and is kept.
    expect(candidate?.url).toBe(`${WORKDAY_URL}?id=R-12345`);
    // The arrow decoration is dropped: the label is read by a human, not parsed.
    expect(candidate?.label).toBe('Apply Now');
  });
});

/** A candidate at a chosen score, for the picker's own tests. */
function candidate(score: number, url: string): ApplyUrlCandidate {
  return {
    url,
    finalUrl: null,
    confidence:
      score >= 9 ? 'highest' : score >= 5 ? 'high' : score >= 4 ? 'medium' : 'low',
    score,
    reason: 'fixture',
    label: null,
  };
}

describe('pickConfidentCandidate', () => {
  it('returns nothing for an empty list', () => {
    expect(pickConfidentCandidate([])).toBeNull();
  });

  it('returns the best candidate when it is clearly ahead', () => {
    const best = candidate(12, 'https://a.test/careers/job/1');
    expect(pickConfidentCandidate([best, candidate(5, 'https://b.test/jobs/2')])).toBe(best);
  });

  it('refuses a merely medium best candidate', () => {
    expect(pickConfidentCandidate([candidate(4, 'https://a.test/x')])).toBeNull();
  });

  it('refuses a near tie, because a wrong apply button is worse than none', () => {
    const best = candidate(6, 'https://a.test/careers/job/1');
    expect(pickConfidentCandidate([best, candidate(5, 'https://b.test/jobs/2')])).toBeNull();
  });

  it('accepts a gap of more than one point', () => {
    const best = candidate(7, 'https://a.test/careers/job/1');
    expect(pickConfidentCandidate([best, candidate(5, 'https://b.test/jobs/2')])).toBe(best);
  });
});
