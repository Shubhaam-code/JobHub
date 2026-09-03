/**
 * Rewriting aggregator links that live *inside* a job description.
 *
 * A more cautious pass than the apply-field repair, because the risk is different:
 * the apply field holds one URL that can be cleared and re-derived, while a
 * description is prose a user reads. A bad edit here corrupts content.
 *
 * So the tests below are mostly about restraint. Only the URL's own byte range
 * changes; anchor text, attributes and whitespace come out identical. A URL that is
 * merely *mentioned* — "posted on freshershunt" — is not a call to action and is
 * left alone even though the same URL in an "Apply here:" sentence would be
 * rewritten.
 *
 * `rewriteBodies` itself streams a Mongo cursor and is exercised through the CLI;
 * what is unit-tested here is the string surgery it performs, because that is the
 * part that can silently mangle a body.
 */

import { describe, expect, it } from 'vitest';

import {
  findBodyUrls,
  hasApplyContext,
  spliceBody,
} from '../src/apply-url/body-rewrite.js';

const ARTICLE_URL = 'https://freshershunt.in/cognizant-off-campus-drive-2026';
const WORKDAY_URL =
  'https://cognizant.wd1.myworkdayjobs.com/en-US/Cognizant_Careers/job/R-12345';

describe('findBodyUrls', () => {
  it('reports offsets that select exactly the URL', () => {
    const body = `Apply here: ${ARTICLE_URL} before 30 September.`;
    const [match] = findBodyUrls(body);

    expect(match?.raw).toBe(ARTICLE_URL);
    // The invariant the splice depends on.
    expect(body.slice(match?.start ?? 0, match?.end ?? 0)).toBe(ARTICLE_URL);
  });

  it('leaves sentence punctuation out of the URL', () => {
    const [match] = findBodyUrls(`Apply at ${ARTICLE_URL}.`);

    expect(match?.raw).toBe(ARTICLE_URL);
  });

  it('finds every URL in a body, in order', () => {
    const body = `First ${ARTICLE_URL} then ${WORKDAY_URL} done`;
    const matches = findBodyUrls(body);

    expect(matches.map((match) => match.raw)).toEqual([ARTICLE_URL, WORKDAY_URL]);
    expect(matches[0]?.start).toBeLessThan(matches[1]?.start ?? 0);
  });

  it('stops a URL at an href quote rather than swallowing the markup', () => {
    const [match] = findBodyUrls(`<a href="${ARTICLE_URL}">Apply Now</a>`);

    expect(match?.raw).toBe(ARTICLE_URL);
  });

  it('finds nothing in a body with no links', () => {
    expect(findBodyUrls('Walk-in drive at the Chennai office on Monday.')).toEqual([]);
  });
});

describe('hasApplyContext', () => {
  /** The offsets of the single URL in `body`. */
  function offsets(body: string): { start: number; end: number } {
    const match = findBodyUrls(body)[0];
    if (match === undefined) throw new Error('fixture has no URL');
    return { start: match.start, end: match.end };
  }

  it('accepts text that introduces the link', () => {
    const body = `Apply here: ${ARTICLE_URL}`;
    const { start, end } = offsets(body);

    expect(hasApplyContext(body, start, end)).toBe(true);
  });

  it('accepts text that follows the link', () => {
    const body = `${ARTICLE_URL} — click here to apply before Friday`;
    const { start, end } = offsets(body);

    expect(hasApplyContext(body, start, end)).toBe(true);
  });

  it('refuses a passing mention', () => {
    // A rewrite here would change the meaning of a sentence about provenance.
    const body = `This opening was originally posted on ${ARTICLE_URL} last week.`;
    const { start, end } = offsets(body);

    expect(hasApplyContext(body, start, end)).toBe(false);
  });

  it('ignores an apply word too far away to be about this link', () => {
    const body = `Apply soon. ${'x'.repeat(200)} ${ARTICLE_URL}`;
    const { start, end } = offsets(body);

    expect(hasApplyContext(body, start, end)).toBe(false);
  });
});

describe('spliceBody', () => {
  it('changes the URL and nothing else', () => {
    const body = `Apply here: <a href="${ARTICLE_URL}">Apply Now</a> before 30 Sept.`;
    const [match] = findBodyUrls(body);

    const result = spliceBody(body, [
      { start: match?.start ?? 0, end: match?.end ?? 0, url: WORKDAY_URL },
    ]);

    expect(result).toBe(`Apply here: <a href="${WORKDAY_URL}">Apply Now</a> before 30 Sept.`);
    // Anchor text, attributes and surrounding prose are byte-identical.
    expect(result.replace(WORKDAY_URL, ARTICLE_URL)).toBe(body);
  });

  it('applies several replacements without shifting each other', () => {
    const body = `A ${ARTICLE_URL} B ${ARTICLE_URL} C`;
    const matches = findBodyUrls(body);

    const result = spliceBody(
      body,
      matches.map((match) => ({ start: match.start, end: match.end, url: WORKDAY_URL })),
    );

    expect(result).toBe(`A ${WORKDAY_URL} B ${WORKDAY_URL} C`);
  });

  it('is order-independent, because splices run back to front', () => {
    const body = `A ${ARTICLE_URL} B ${WORKDAY_URL} C`;
    const [first, second] = findBodyUrls(body);
    if (first === undefined || second === undefined) throw new Error('fixture');

    const ascending = spliceBody(body, [
      { start: first.start, end: first.end, url: 'https://one.test/apply' },
      { start: second.start, end: second.end, url: 'https://two.test/apply' },
    ]);

    const descending = spliceBody(body, [
      { start: second.start, end: second.end, url: 'https://two.test/apply' },
      { start: first.start, end: first.end, url: 'https://one.test/apply' },
    ]);

    expect(ascending).toBe('A https://one.test/apply B https://two.test/apply C');
    expect(descending).toBe(ascending);
  });

  it('returns the body untouched when there is nothing to replace', () => {
    const body = `Apply at ${WORKDAY_URL}`;
    expect(spliceBody(body, [])).toBe(body);
  });

  it('handles a replacement of a different length', () => {
    const body = `Apply: ${ARTICLE_URL} now`;
    const [match] = findBodyUrls(body);

    expect(
      spliceBody(body, [{ start: match?.start ?? 0, end: match?.end ?? 0, url: 'https://a.test' }]),
    ).toBe('Apply: https://a.test now');
  });
});
