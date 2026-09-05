/**
 * The apply-link classifier.
 *
 * This file is the contract for "what counts as a link we may store". It is
 * organized around the two ways the classifier can fail in production, and the
 * second is much worse than the first:
 *
 *  - a **false negative** sends a working link to the review queue: annoying, and
 *    a human fixes it in one click;
 *  - a **false positive** publishes an aggregator URL as our apply button, which is
 *    the entire bug this feature exists to close.
 *
 * So the bypass block below is not defensive box-ticking. Each case is a spelling
 * of `freshershunt.in` that a naive substring or regex check would wave through,
 * and every one of them must come back `aggregator`.
 */

import { describe, expect, it } from 'vitest';

import {
  classifyApplyUrl,
  hostMatchesCompany,
  hostOfUrl,
  normalizeApplyUrl,
} from '../src/apply-url/classify.js';

const AGGREGATOR = 'freshershunt.in';

describe('normalizeApplyUrl', () => {
  it('returns null for values that are not usable http(s) URLs', () => {
    expect(normalizeApplyUrl(null)).toBeNull();
    expect(normalizeApplyUrl(undefined)).toBeNull();
    expect(normalizeApplyUrl('')).toBeNull();
    expect(normalizeApplyUrl('   ')).toBeNull();
    expect(normalizeApplyUrl('not a url')).toBeNull();
    expect(normalizeApplyUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeApplyUrl('data:text/html,<h1>hi</h1>')).toBeNull();
    expect(normalizeApplyUrl('mailto:jobs@acme.com')).toBeNull();
  });

  it('adds a scheme, lowercases the host and drops www.', () => {
    expect(normalizeApplyUrl('CAREERS.Acme.COM/jobs/12')).toBe('https://careers.acme.com/jobs/12');
    expect(normalizeApplyUrl('https://WWW.Acme.com/careers')).toBe('https://acme.com/careers');
  });

  it('upgrades http to https and strips a trailing dot from the host', () => {
    expect(normalizeApplyUrl('http://careers.acme.com./jobs')).toBe(
      'https://careers.acme.com/jobs',
    );
  });

  it('drops tracking parameters but keeps the ones that identify the job', () => {
    expect(
      normalizeApplyUrl(
        'https://careers.acme.com/apply?jobId=8891&utm_source=telegram&utm_medium=post&fbclid=x&gclid=y&ref=z',
      ),
    ).toBe('https://careers.acme.com/apply?jobId=8891');
  });

  it('drops the fragment and a lone trailing slash', () => {
    expect(normalizeApplyUrl('https://careers.acme.com/jobs/12/#apply')).toBe(
      'https://careers.acme.com/jobs/12',
    );
  });

  it('keeps the slash on a bare host, which has no path to trim', () => {
    expect(normalizeApplyUrl('https://acme.com')).toBe('https://acme.com/');
  });

  it('strips zero-width and bidi marks glued on by a forwarded post', () => {
    expect(normalizeApplyUrl('​https://careers.acme.com/jobs/12‎')).toBe(
      'https://careers.acme.com/jobs/12',
    );
  });

  it('unwraps a ?url= style redirector to its destination', () => {
    expect(
      normalizeApplyUrl(
        'https://l.facebook.com/l.php?u=https%3A%2F%2Fcareers.acme.com%2Fjobs%2F12&h=AT1',
      ),
    ).toBe('https://careers.acme.com/jobs/12');
  });

  it('normalizes the destination, not the wrapper, when the target is an aggregator', () => {
    expect(normalizeApplyUrl(`https://l.facebook.com/l.php?u=https://${AGGREGATOR}/cognizant-2026/`)).toBe(
      `https://${AGGREGATOR}/cognizant-2026`,
    );
  });
});

/**
 * The list-bypass suite. Every case here is `freshershunt.in` wearing a disguise.
 *
 * The classifier matches on `new URL(...).hostname`, so these pass structurally
 * rather than by enumerating tricks — but they are asserted individually because
 * the cost of a regression is a competitor's link on our apply button.
 */
describe('classifyApplyUrl — aggregator list cannot be bypassed', () => {
  const bypasses: readonly [name: string, url: string][] = [
    ['plain https', `https://${AGGREGATOR}/cognizant-service-desk-off-campus-2026/`],
    ['http instead of https', `http://${AGGREGATOR}/cognizant-off-campus-2026/`],
    ['scheme-less', `${AGGREGATOR}/cognizant-off-campus-2026/`],
    ['protocol-relative', `//${AGGREGATOR}/cognizant-off-campus-2026/`],
    ['uppercase host', `https://FRESHERSHUNT.IN/cognizant-2026/`],
    ['mixed case with WWW.', `https://WWW.FresherSHunt.In/cognizant-2026/`],
    ['trailing dot on the host', `https://${AGGREGATOR}./cognizant-2026/`],
    ['multiple trailing dots', `https://${AGGREGATOR}.../cognizant-2026/`],
    ['added subdomain', `https://careers.${AGGREGATOR}/cognizant-2026/`],
    ['deep subdomain', `https://apply.jobs.careers.${AGGREGATOR}/x`],
    ['userinfo prefix pretending to be the employer', `https://careers.cognizant.com@${AGGREGATOR}/cognizant-2026/`],
    ['userinfo with a password', `https://careers.cognizant.com:pass@${AGGREGATOR}/x`],
    ['path traversal in the path', `https://${AGGREGATOR}/../careers/apply`],
    ['a careers-looking path', `https://${AGGREGATOR}/careers/apply/`],
    ['an ATS-looking path', `https://${AGGREGATOR}/myworkdayjobs.com/apply`],
    ['a trusted host as a query parameter', `https://${AGGREGATOR}/x?ats=greenhouse.io`],
    ['explicit port', `https://${AGGREGATOR}:443/cognizant-2026/`],
    ['tracking params attached', `https://${AGGREGATOR}/cognizant-2026/?utm_source=telegram`],
    ['fragment pointing at an apply anchor', `https://${AGGREGATOR}/cognizant-2026/#apply-now`],
    ['zero-width characters inside the URL', `https://fresher\u200Bshunt.in/cognizant-2026/`],
    ['wrapped in a ?url= redirector', `https://bit.ly/x?url=https://${AGGREGATOR}/cognizant-2026/`],
    ['wrapped in a Facebook l.php redirector', `https://l.facebook.com/l.php?u=https%3A%2F%2F${AGGREGATOR}%2Fx`],
  ];

  for (const [name, url] of bypasses) {
    it(`rejects ${name}`, () => {
      const result = classifyApplyUrl(url, { company: 'Cognizant' });
      expect(result.verdict, `${name} → ${url}`).toBe('aggregator');
    });
  }

  it('does not reject a different domain that merely ends with the same letters', () => {
    // `notfreshershunt.in` is not a subdomain of `freshershunt.in`. The
    // endsWith('.' + entry) rule is what keeps this from matching.
    expect(classifyApplyUrl('https://notfreshershunt.in/jobs/12').verdict).not.toBe('aggregator');
  });

  it('does not treat a trusted domain as an aggregator because of a path segment', () => {
    expect(
      classifyApplyUrl('https://acme.wd1.myworkdayjobs.com/careers/freshershunt.in').verdict,
    ).toBe('direct');
  });
});

describe('classifyApplyUrl — punycode and IDN homoglyphs', () => {
  it('never lets a punycode host pass as a trusted ATS', () => {
    // xn--myworkdayjbs-... is a lookalike, not myworkdayjobs.com.
    const result = classifyApplyUrl('https://acme.xn--myworkdayjbs-p8a.com/apply');
    expect(result.verdict).not.toBe('direct');
    expect(result.verdict).toBe('suspicious');
    expect(result.reason).toMatch(/punycode/i);
  });

  it('flags a unicode homoglyph host rather than accepting it', () => {
    // Cyrillic 'а' in "careers". The URL parser converts it to an xn-- label.
    const result = classifyApplyUrl('https://cаreers.cognizant.com/apply', {
      company: 'Cognizant',
    });
    expect(result.verdict).toBe('suspicious');
    expect(result.reason).toMatch(/punycode/i);
  });
});

describe('classifyApplyUrl — own domain is a loop', () => {
  it('rejects a link back at our own frontend', () => {
    const result = classifyApplyUrl('https://job-hub-web-ochre.vercel.app/jobs/abc123');
    expect(result.verdict).toBe('aggregator');
    expect(result.reason).toMatch(/loop/i);
  });
});

/**
 * The fixture table from the brief: one row per shape of input we actually see.
 */
describe('classifyApplyUrl — fixture table', () => {
  const fixtures: readonly [name: string, url: string, expected: string][] = [
    ['aggregator article', `https://${AGGREGATOR}/cognizant-service-desk-off-campus-2026/`, 'aggregator'],
    ['trusted ATS — Workday', 'https://acme.wd1.myworkdayjobs.com/en-US/careers/job/R-991', 'direct'],
    ['trusted ATS — Greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/4001', 'direct'],
    ['trusted ATS — Lever', 'https://jobs.lever.co/acme/1a2b3c', 'direct'],
    ['trusted ATS — Oracle Cloud', 'https://ejgk.fa.em2.oraclecloud.com/hcmUI/CandidateExperience/job/1234', 'direct'],
    ['employer careers subdomain', 'https://careers.acme.com/job/1188364', 'direct'],
    ['employer domain with a careers path', 'https://acme.com/careers/software-engineer', 'direct'],
    ['Google Form', 'https://docs.google.com/forms/d/e/1FAIpQL/viewform', 'direct'],
    ['forms.gle short form', 'https://forms.gle/aB3xY9', 'direct'],
    ['Microsoft form', 'https://forms.office.com/Pages/ResponsePage.aspx?id=abc', 'direct'],
    ['government portal', 'https://drdo.gov.in/recruitment/apply', 'direct'],
    ['university portal', 'https://iitk.ac.in/tpc/apply', 'direct'],
    ['unresolved shortener', 'https://bit.ly/3xYzAbc', 'wrapper'],
    ['unresolved t.co', 'https://t.co/aBcDeF', 'wrapper'],
    ['placement shortener observed in our data', 'https://pdlink.in/AbCd12', 'wrapper'],
    ['docs.google.com without a form path', 'https://docs.google.com/document/d/abc/edit', 'suspicious'],
    ['suspicious host fragment', 'https://freshersworld.example/jobs/12', 'suspicious'],
    ['SEO article slug on an unknown host', 'https://randomsite.test/tcs-off-campus-drive-2026/', 'suspicious'],
    ['unknown host, no signal', 'https://randomsite.test/x', 'suspicious'],
    ['empty', '', 'unresolvable'],
    ['malformed', 'ht!tp://??', 'unresolvable'],
    ['host with no dot', 'https://intranet/apply', 'unresolvable'],
  ];

  for (const [name, url, expected] of fixtures) {
    it(`${name} → ${expected}`, () => {
      const result = classifyApplyUrl(url, { company: 'Acme' });
      expect(result.verdict, `${name} → ${url} (${result.reason})`).toBe(expected);
    });
  }

  it('keeps tracking parameters out of the normalized form it reports', () => {
    const result = classifyApplyUrl(
      'https://careers.acme.com/job/1?utm_source=telegram&jobId=1',
      { company: 'Acme' },
    );
    expect(result.verdict).toBe('direct');
    expect(result.normalizedUrl).toBe('https://careers.acme.com/job/1?jobId=1');
  });

  it('routes a LinkedIn posting to review rather than accepting it', () => {
    // A LinkedIn job page is a real place to apply but is not employer-owned, so
    // it is a human's call. Asserted so the decision is visible, not incidental.
    expect(classifyApplyUrl('https://linkedin.com/jobs/view/4001').verdict).toBe('suspicious');
  });
});

describe('hostOfUrl', () => {
  it('reports the parser hostname, lowercased and without www. or a trailing dot', () => {
    expect(hostOfUrl('https://WWW.Acme.COM./jobs')).toBe('acme.com');
  });

  it('reports the host after the userinfo, not the deceptive prefix', () => {
    expect(hostOfUrl(`https://careers.cognizant.com@${AGGREGATOR}/x`)).toBe(AGGREGATOR);
  });

  it('returns null for an unparseable value', () => {
    expect(hostOfUrl('not a url')).toBeNull();
  });
});

describe('hostMatchesCompany', () => {
  it('matches a company token against a host label', () => {
    expect(hostMatchesCompany('careers.cognizant.com', 'Cognizant')).toBe(true);
    expect(hostMatchesCompany('cognizant-careers.com', 'Cognizant Technology Solutions')).toBe(true);
  });

  it('matches a multi-word name run together, hyphenated, or as one label', () => {
    /* The most ordinary employer domain there is: a two-word company on one
       registered label. Matching token-by-token alone missed it, which cost the
       page its "official source" standing and so its verification. */
    expect(hostMatchesCompany('careers.acmerobotics.com', 'Acme Robotics')).toBe(true);
    expect(hostMatchesCompany('acme-robotics.com', 'Acme Robotics')).toBe(true);
    expect(hostMatchesCompany('careers.acme.com', 'Acme Robotics')).toBe(true);
  });

  it('still compares whole labels, so a lookalike host does not match', () => {
    // The company name appearing *inside* a label, or as someone else's
    // subdomain, is how a lookalike would be dressed up.
    expect(hostMatchesCompany('acmerobotics.evil.test', 'Acme Robotics')).toBe(false);
    expect(hostMatchesCompany('notacmerobotics.com', 'Acme Robotics')).toBe(false);
    expect(hostMatchesCompany('acmeroboticsxyz.com', 'Acme Robotics')).toBe(false);
  });

  it('ignores generic tokens that would match almost any host', () => {
    // "Technologies"/"India" must not make `jobs.technologies-india.test` a match.
    expect(hostMatchesCompany('careers.acme.com', 'Global Technologies India Pvt Ltd')).toBe(false);
  });

  it('is false when there is no company to compare against', () => {
    expect(hostMatchesCompany('careers.acme.com', null)).toBe(false);
    expect(hostMatchesCompany('careers.acme.com', '')).toBe(false);
  });
});
