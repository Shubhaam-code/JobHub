import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearCompanyLogoCache,
  companyDomainCandidates,
  companyLogoCacheKey,
  companyLogoUrl,
  domainMatchesCompany,
  findCompanyLogoUrl,
  isKnownCompanyDomain,
  isLogoWorthyCompany,
  normalizeCompanyName,
  resolveCompanyLogo,
  type DomainOwnerCheck,
} from '../src/telegram/company-logo.js';

/** A probe stub plus the URLs it was asked about, so "no request" is testable. */
function createProbe(outcome: (url: string) => boolean = () => true) {
  const seen: string[] = [];

  const probe = vi.fn(async (url: string): Promise<boolean> => {
    seen.push(url);
    return outcome(url);
  });

  return { probe, seen };
}

/**
 * An owner check that confirms whatever it is asked about, plus the domains it
 * saw. The default for tests about the icon probe, so none of them touch the
 * network for the second verification step.
 */
function createOwnerCheck(
  outcome: (domain: string) => Partial<DomainOwnerCheck> = () => ({}),
) {
  const seen: string[] = [];

  const checkDomainOwner = vi.fn(async (domain: string): Promise<DomainOwnerCheck> => {
    seen.push(domain);
    return {
      reachable: true,
      finalHost: domain,
      // Confirms by default: the site names itself after the guessed host.
      siteName: domain.replace(/\.[a-z.]+$/, ''),
      parked: false,
      ...outcome(domain),
    };
  });

  return { checkDomainOwner, seen };
}

/** True only for the provider URL built from `domain`. */
function onlyDomain(domain: string) {
  return (url: string) => url.includes(encodeURIComponent(domain));
}

beforeEach(() => {
  clearCompanyLogoCache();
});

describe('normalizeCompanyName', () => {
  it('lowercases, collapses whitespace and drops legal suffixes', () => {
    expect(normalizeCompanyName('  Zoho   Corporation ')).toBe('zoho');
    expect(normalizeCompanyName('Infosys Limited')).toBe('infosys');
    expect(normalizeCompanyName('Acme Pvt Ltd')).toBe('acme');
    expect(normalizeCompanyName('Wipro Technologies')).toBe('wipro technologies');
  });

  it('removes bracketed asides and channel noise from the name', () => {
    expect(normalizeCompanyName('Deloitte (Off Campus Drive)')).toBe('deloitte');
    expect(normalizeCompanyName('Google Off-Campus Hiring 2026')).toBe('google');
  });

  it('spells out & so the name survives as words', () => {
    expect(normalizeCompanyName('Johnson & Johnson')).toBe('johnson and johnson');
  });

  it('answers empty for a name that is absent or has no content', () => {
    for (const value of [null, undefined, '', '   ', '★★★', '---']) {
      expect(normalizeCompanyName(value)).not.toMatch(/[a-z0-9]/);
    }
  });

  it('keeps a name already written as a domain intact', () => {
    expect(normalizeCompanyName('zoho.com')).toBe('zoho.com');
    expect(normalizeCompanyName('BYJUS.in')).toBe('byjus.in');
  });
});

describe('companyLogoCacheKey — one key per company', () => {
  it('maps casing, spacing and entity-suffix variants onto one key', () => {
    const key = companyLogoCacheKey('Zoho');

    for (const variant of ['zoho', 'ZOHO', '  Zoho  ', 'Zoho Corporation', 'Zoho Pvt Ltd']) {
      expect(companyLogoCacheKey(variant)).toBe(key);
    }
  });

  it('keeps distinct companies on distinct keys', () => {
    expect(companyLogoCacheKey('Infosys')).not.toBe(companyLogoCacheKey('Wipro'));
  });
});

describe('isLogoWorthyCompany — placeholders never get a logo', () => {
  it('accepts a real company name', () => {
    for (const name of ['Microsoft', 'Tata Consultancy Services', 'Zoho', 'HP', 'Infosys Ltd']) {
      expect(isLogoWorthyCompany(name)).toBe(true);
    }
  });

  it('rejects a placeholder that identifies no company', () => {
    const placeholders = [
      'Confidential',
      'confidential',
      'MNC',
      'Top MNC',
      'Various',
      'Multiple Companies',
      'Startup',
      'Company',
      'Client',
      'Not Specified',
      'N/A',
      'Unknown',
      'TBD',
      'Product Based Company',
      'Hiring',
    ];

    for (const name of placeholders) {
      expect(isLogoWorthyCompany(name), name).toBe(false);
    }
  });

  it('rejects a missing, empty or letterless name', () => {
    for (const name of [null, undefined, '', '  ', '2026', '---', 'X']) {
      expect(isLogoWorthyCompany(name)).toBe(false);
    }
  });

  it('rejects a sentence pasted into the company field', () => {
    expect(
      isLogoWorthyCompany('We are hiring software engineers for our client in Bangalore now'),
    ).toBe(false);
  });
});

describe('companyDomainCandidates — guessing a hostname', () => {
  it('compacts a name into .com, .in and .co.in guesses, best first', () => {
    expect(companyDomainCandidates('Zoho')).toEqual(['zoho.com', 'zoho.in', 'zoho.co.in']);
  });

  it('compacts a multi-word name as a whole, never a single word of it', () => {
    const candidates = companyDomainCandidates('Bank of America');

    expect(candidates[0]).toBe('bankofamerica.com');
    // The failure this guards against: "Bank of America" becoming bank.com.
    expect(candidates).not.toContain('bank.com');
  });

  it('trusts a name that is already a domain instead of rebuilding one', () => {
    expect(companyDomainCandidates('zoho.com')).toEqual(['zoho.com']);
    expect(companyDomainCandidates('www.byjus.in')).toEqual(['byjus.in']);
  });

  it('returns nothing for a placeholder or unusable name', () => {
    for (const name of ['Confidential', 'MNC', '', null, undefined, '2026']) {
      expect(companyDomainCandidates(name)).toEqual([]);
    }
  });
});

describe('companyLogoUrl', () => {
  it('substitutes the domain into the configured template', () => {
    expect(companyLogoUrl('zoho.com')).toBe('https://icons.duckduckgo.com/ip3/zoho.com.ico');
  });
});

describe('resolveCompanyLogo — verification before trust', () => {
  it('returns the logo for the first domain the provider confirms', async () => {
    const { probe, seen } = createProbe(onlyDomain('zoho.com'));
    const { checkDomainOwner } = createOwnerCheck();

    const result = await resolveCompanyLogo('Zoho Corporation', { probe, checkDomainOwner });

    expect(result).toEqual({ url: companyLogoUrl('zoho.com'), source: 'network' });
    expect(seen).toEqual([companyLogoUrl('zoho.com')]);
  });

  it('falls through to the next guess when the first is not confirmed', async () => {
    const { probe, seen } = createProbe(onlyDomain('acmecorp.in'));
    const { checkDomainOwner } = createOwnerCheck();

    const result = await resolveCompanyLogo('AcmeCorp', { probe, checkDomainOwner });

    expect(result.url).toBe(companyLogoUrl('acmecorp.in'));
    expect(seen).toEqual([companyLogoUrl('acmecorp.com'), companyLogoUrl('acmecorp.in')]);
  });

  it('answers null when no guess is confirmed — the UI fallback, not an error', async () => {
    const { probe } = createProbe(() => false);
    const { checkDomainOwner } = createOwnerCheck();

    const result = await resolveCompanyLogo('Nonexistent Widget Makers', {
      probe,
      checkDomainOwner,
    });

    expect(result.url).toBeNull();
    expect(result.source).toBe('network');
    expect(result.reason).toContain('no logo found');
    // The icon never verified, so the homepage was never asked about.
    expect(checkDomainOwner).not.toHaveBeenCalled();
  });

  it('makes no request at all for a placeholder company', async () => {
    const { probe } = createProbe();
    const { checkDomainOwner } = createOwnerCheck();

    const result = await resolveCompanyLogo('Confidential', { probe, checkDomainOwner });

    expect(probe).not.toHaveBeenCalled();
    expect(checkDomainOwner).not.toHaveBeenCalled();
    expect(result).toEqual({ url: null, source: 'skipped' });
  });

  it('makes no request for a missing company name', async () => {
    const { probe } = createProbe();
    const { checkDomainOwner } = createOwnerCheck();

    for (const name of [null, undefined, '', '   ']) {
      expect(await resolveCompanyLogo(name, { probe, checkDomainOwner })).toEqual({
        url: null,
        source: 'skipped',
      });
    }

    expect(probe).not.toHaveBeenCalled();
    expect(checkDomainOwner).not.toHaveBeenCalled();
  });
});

/**
 * The icon provider serves an icon for every *registered* domain, so it cannot
 * tell a company's own site from a parked one. These are the tests for the check
 * that can — and the failures they encode were all observed on real data during
 * the first backfill dry run.
 */
describe('resolveCompanyLogo — an icon is not proof of ownership', () => {
  it('rejects a domain whose homepage is a for-sale lander', async () => {
    const { probe } = createProbe();
    const { checkDomainOwner } = createOwnerCheck(() => ({
      siteName: 'upsc.in - This website is for sale! - upsc Resources and Information',
      parked: true,
    }));

    const result = await resolveCompanyLogo('UPSC Coaching Centre', { probe, checkDomainOwner });

    expect(probe).toHaveBeenCalled();
    expect(result.url).toBeNull();
    expect(result.reason).toContain('belong to someone else');
  });

  it('rejects a domain that belongs to a different company', async () => {
    const { probe } = createProbe();
    // indigo.com is a Canadian bookstore; the airline is goindigo.in.
    const { checkDomainOwner } = createOwnerCheck(() => ({
      finalHost: 'indigo.ca',
      siteName: 'Indigo Books and Music',
    }));

    const result = await resolveCompanyLogo('Airline Widget Partners', {
      probe,
      checkDomainOwner,
    });

    expect(result.url).toBeNull();
  });

  it('rejects a domain that has an icon but no reachable site', async () => {
    const { probe } = createProbe();
    const { checkDomainOwner } = createOwnerCheck(() => ({
      reachable: false,
      finalHost: '',
      siteName: '',
    }));

    const result = await resolveCompanyLogo('Nonstandard Holdings', { probe, checkDomainOwner });

    expect(result.url).toBeNull();
    expect(result.reason).toContain('belong to someone else');
  });

  it('accepts a rebranded domain that redirects to the real company', async () => {
    const { probe } = createProbe(onlyDomain('acmewidgets.com'));
    // acmewidgets.com → acme-widgets.io, still genuinely the same company.
    const { checkDomainOwner } = createOwnerCheck(() => ({
      finalHost: 'acme-widgets.io',
      siteName: 'Acme Widgets | Industrial Fasteners',
    }));

    const result = await resolveCompanyLogo('Acme Widgets', { probe, checkDomainOwner });

    expect(result.url).toBe(companyLogoUrl('acmewidgets.com'));
  });

  it('answers null rather than throwing when the ownership check throws', async () => {
    const { probe } = createProbe();
    const checkDomainOwner = vi
      .fn<(domain: string) => Promise<DomainOwnerCheck>>()
      .mockRejectedValue(new Error('ERR_TLS_CERT_ALTNAME_INVALID'));

    const result = await resolveCompanyLogo('Some Company', { probe, checkDomainOwner });

    expect(result.url).toBeNull();
  });

  it('skips the ownership check for a hand-curated hostname', async () => {
    const { probe } = createProbe();
    const { checkDomainOwner } = createOwnerCheck();

    // hpe.com was verified by hand; hewlettpackardenterprise.com does not resolve.
    const result = await resolveCompanyLogo('Hewlett Packard Enterprise', {
      probe,
      checkDomainOwner,
    });

    expect(result.url).toBe(companyLogoUrl('hpe.com'));
    expect(checkDomainOwner).not.toHaveBeenCalled();
  });
});

describe('KNOWN_COMPANY_DOMAINS — names no guess can reach', () => {
  it('maps a company whose guessed domain is dead or someone else’s', () => {
    const expected: Array<[string, string]> = [
      ['Hewlett Packard Enterprise', 'hpe.com'],
      ['HPE', 'hpe.com'],
      ['Deutsche Bank', 'db.com'],
      ['Larsen & Toubro (L&T)', 'larsentoubro.com'],
      ['IndiGo', 'goindigo.in'],
      ['India Post', 'indiapost.gov.in'],
      ['ISRO', 'isro.gov.in'],
      ['UPSC', 'upsc.gov.in'],
      ['State Bank of India (SBI)', 'sbi.co.in'],
      ['Tata Consultancy Services', 'tcs.com'],
      ['Micron Technology', 'micron.com'],
      ['Fujitsu', 'global.fujitsu'],
      ['Yash Technologies', 'yash.com'],
    ];

    for (const [name, domain] of expected) {
      expect(companyDomainCandidates(name), name).toEqual([domain]);
      expect(isKnownCompanyDomain(name), name).toBe(true);
    }
  });

  it('leaves every other company to the ordinary guesses', () => {
    expect(isKnownCompanyDomain('Zoho')).toBe(false);
    expect(companyDomainCandidates('Zoho')).toHaveLength(3);
  });
});

describe('domainMatchesCompany', () => {
  function check(overrides: Partial<DomainOwnerCheck> = {}): DomainOwnerCheck {
    return { reachable: true, finalHost: '', siteName: '', parked: false, ...overrides };
  }

  it('accepts a page whose name contains the company name', () => {
    expect(
      domainMatchesCompany('Micron', 'micron.com', check({ siteName: 'Micron Technology | Memory' })),
    ).toBe(true);
  });

  it('accepts a page whose name is contained by the company name', () => {
    expect(domainMatchesCompany('Zoho Corporation', 'zoho.com', check({ siteName: 'Zoho' }))).toBe(
      true,
    );
  });

  it('rejects an unreachable or parked page whatever it is named', () => {
    expect(domainMatchesCompany('Acme', 'acme.com', check({ reachable: false }))).toBe(false);
    expect(
      domainMatchesCompany('Acme', 'acme.com', check({ siteName: 'Acme', parked: true })),
    ).toBe(false);
  });

  it('rejects a page belonging to an unrelated company', () => {
    // indigo.com serves a bookstore; the airline never appears in its name.
    expect(
      domainMatchesCompany('IndiGo Airlines', 'indigo.com', check({ siteName: 'Chapters Books' })),
    ).toBe(false);
  });

  /**
   * A shared word is all this check has to go on, so a name that *contains* the
   * company name passes even when the owner is someone else ("Tower" against
   * "Tower Records"). Guessing narrower would lose "Micron Technology | Memory";
   * such names belong in KNOWN_COMPANY_DOMAINS instead.
   */
  it('cannot separate a company from a same-named unrelated one', () => {
    expect(
      domainMatchesCompany('Tower', 'tower.com', check({ siteName: 'Tower Records' })),
    ).toBe(true);
  });

  it('does not treat the guessed hostname itself as evidence', () => {
    // Every registered domain would pass if the guess counted as its own proof.
    expect(
      domainMatchesCompany('Novac', 'novac.com', check({ finalHost: 'novac.com', siteName: '' })),
    ).toBe(false);
  });

  it('does treat a redirect target as evidence', () => {
    expect(
      domainMatchesCompany('Zeta', 'zeta.in', check({ finalHost: 'zeta.tech', siteName: '' })),
    ).toBe(true);
  });
});

describe('resolveCompanyLogo — failure safety', () => {
  it('answers null rather than throwing when the probe throws', async () => {
    const probe = vi.fn<(url: string) => Promise<boolean>>().mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND'),
    );

    const result = await resolveCompanyLogo('Zoho', { probe });

    expect(result.url).toBeNull();
  });

  it('findCompanyLogoUrl never rejects', async () => {
    const probe = vi
      .fn<(url: string) => Promise<boolean>>()
      .mockRejectedValue(new Error('socket hang up'));

    await expect(findCompanyLogoUrl('Zoho', { probe })).resolves.toBeNull();
  });
});

describe('resolveCompanyLogo — one lookup per company', () => {
  it('serves a second job for the same company from the cache', async () => {
    const { probe } = createProbe(onlyDomain('zoho.com'));
    const { checkDomainOwner } = createOwnerCheck();

    const first = await resolveCompanyLogo('Zoho', { probe, checkDomainOwner });
    const second = await resolveCompanyLogo('Zoho Corporation', { probe, checkDomainOwner });

    expect(probe).toHaveBeenCalledTimes(1);
    expect(checkDomainOwner).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ url: first.url, source: 'cache' });
  });

  it('remembers a miss too, so a hopeless name is probed once', async () => {
    const { probe } = createProbe(() => false);
    const { checkDomainOwner } = createOwnerCheck();

    await resolveCompanyLogo('Nonexistent Widget Makers', { probe, checkDomainOwner });
    const probesAfterFirst = probe.mock.calls.length;
    const second = await resolveCompanyLogo('Nonexistent Widget Makers', {
      probe,
      checkDomainOwner,
    });

    expect(probe).toHaveBeenCalledTimes(probesAfterFirst);
    expect(second).toEqual({
      url: null,
      source: 'cache',
      reason: 'no verified logo for this company (cached)',
    });
  });

  it('reuses a logo already stored on an earlier job without any request', async () => {
    const { probe } = createProbe();
    const stored = 'https://icons.duckduckgo.com/ip3/zoho.com.ico';

    const result = await resolveCompanyLogo('Zoho', { probe, storedLogoUrl: stored });

    expect(probe).not.toHaveBeenCalled();
    expect(result).toEqual({ url: stored, source: 'stored' });
  });

  it('caches a stored logo, so later jobs for that company also skip the network', async () => {
    const { probe } = createProbe();
    const stored = 'https://icons.duckduckgo.com/ip3/zoho.com.ico';

    await resolveCompanyLogo('Zoho', { probe, storedLogoUrl: stored });
    const second = await resolveCompanyLogo('Zoho Pvt Ltd', { probe });

    expect(probe).not.toHaveBeenCalled();
    expect(second).toEqual({ url: stored, source: 'cache' });
  });

  it('ignores an empty stored value and looks the company up instead', async () => {
    const { probe } = createProbe(onlyDomain('zoho.com'));
    const { checkDomainOwner } = createOwnerCheck();

    const result = await resolveCompanyLogo('Zoho', {
      probe,
      checkDomainOwner,
      storedLogoUrl: '   ',
    });

    expect(probe).toHaveBeenCalled();
    expect(result.source).toBe('network');
  });
});
