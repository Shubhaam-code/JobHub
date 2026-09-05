/**
 * Intelligent URL Validator with Evidence-Based Verification
 *
 * Multi-signal validation that checks:
 * - Company match (page mentions same company)
 * - Role match (page mentions same/similar role)
 * - Location compatibility (page location matches or is compatible)
 * - Application action (page has actual apply/submit functionality)
 * - Official source (company careers or trusted ATS)
 * - Job status (position is still open/active)
 *
 * Returns verified=true ONLY when evidence is strong across multiple signals.
 * No guessing - insufficient evidence returns verified=false.
 */

import { logger } from '../lib/logger.js';
import {
  classifyApplyUrl,
  hostMatchesCompany,
  hostOfUrl,
  isTrustedAtsHost,
  OFFICIAL_TLD_REGEX,
} from '../apply-url/classify.js';
import { fetchPageHtml } from '../apply-url/fetch-page.js';
import { type JobContext, type ValidationEvidence, type ValidationResult } from './types.js';

const VALIDATION_TIMEOUT_MS = 8000;

/**
 * Validates a candidate URL with comprehensive evidence collection.
 *
 * Verification decision is based on accumulated evidence, not a single score.
 * Requirements for verified=true:
 * - MUST be official source (company or ATS)
 * - MUST have application action
 * - MUST match company (or be trusted ATS)
 * - SHOULD match role (helps confidence but not mandatory for ATS)
 * - SHOULD match location (if specified)
 * - SHOULD show job as active (not closed/expired)
 */
export async function validateApplyUrlWithEvidence(
  url: string,
  context: JobContext,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ValidationResult> {
  const ref = `[url=${url.substring(0, 50)}]`;

  // Start with URL classification.
  const classification = classifyApplyUrl(url, { company: context.company });

  if (classification.verdict !== 'direct') {
    const reason = `not a direct link: ${classification.reason}`;
    return { verified: false, evidence: createEmptyEvidence(reason), reason };
  }

  const host = hostOfUrl(url);
  if (!host) {
    return { verified: false, evidence: createEmptyEvidence('invalid host'), reason: 'invalid host' };
  }

  /* Three ways a host qualifies as official, and the order is the order of
     certainty. A trusted ATS is official regardless of company, because that is
     what an ATS is. An employer host is official because the host itself names the
     employer. A government or academic domain is official because the institution
     publishes its own vacancies — but it is treated as `company_careers`, so the
     page still has to prove it is *this* employer's posting before it verifies. */
  const isTrustedAts = isTrustedAtsHost(host);
  const isCompanyHost = hostMatchesCompany(host, context.company);
  const isOfficialBody = OFFICIAL_TLD_REGEX.test(host);
  const isOfficialSource = isTrustedAts || isCompanyHost || isOfficialBody;

  const officialSourceType: 'company_careers' | 'trusted_ats' | null = isTrustedAts
    ? 'trusted_ats'
    : isOfficialSource
      ? 'company_careers'
      : null;

  // If not an official source, it cannot be verified.
  if (!isOfficialSource) {
    const reason = 'not an official company or ATS source';
    return {
      verified: false,
      evidence: { ...createEmptyEvidence(reason), isOfficialSource: false, officialSourceType: null },
      reason,
    };
  }

  logger.debug(`${ref} official source detected: ${officialSourceType}`);

  // Fetch page content to analyze.
  const page = await fetchPageHtml(url, {
    fetchImpl: options.fetchImpl,
    timeoutMs: VALIDATION_TIMEOUT_MS,
  });

  if (!page.ok) {
    const reason = `page fetch failed: ${page.reason}`;
    return {
      verified: false,
      evidence: { ...createEmptyEvidence(reason), isOfficialSource: true, officialSourceType },
      reason,
    };
  }

  // Analyze page content for evidence.
  const evidence = analyzePageContent(page.html, page.finalUrl ?? url, context, {
    isOfficialSource: true,
    officialSourceType,
  });

  // Decision: verify only when evidence is strong.
  const verified = shouldVerify(evidence);

  const reason = verified
    ? buildVerificationSummary(evidence)
    : buildRejectionReason(evidence);

  // The stored evidence carries its own conclusion, so an admin reading a job
  // document sees why it was decided without re-deriving it from the flags.
  evidence.summary = `${verified ? 'verified' : 'not verified'}: ${reason}`;

  logger.debug(`${ref} validation result: verified=${String(verified)}, ${reason}`);

  return {
    verified,
    evidence,
    reason,
  };
}

/**
 * Analyzes page HTML to collect validation evidence.
 */
function analyzePageContent(
  html: string,
  url: string,
  context: JobContext,
  baseEvidence: Pick<ValidationEvidence, 'isOfficialSource' | 'officialSourceType'>,
): ValidationEvidence {
  const lowerHtml = html.toLowerCase();
  const lowerText = stripHtmlTags(html).toLowerCase();

  // Company match analysis.
  const companyMatch = analyzeCompanyMatch(lowerHtml, lowerText, url, context.company);

  // Role match analysis.
  const roleMatch = analyzeRoleMatch(lowerHtml, lowerText, context.role);

  // Location match analysis.
  const locationMatch = analyzeLocationMatch(lowerHtml, lowerText, context.location);

  // Application action detection.
  const applicationAction = detectApplicationAction(lowerHtml, url);

  // Job status detection.
  const jobStatus = detectJobStatus(lowerHtml, lowerText);

  // Calculate overall confidence.
  const overallConfidence = calculateOverallConfidence({
    ...baseEvidence,
    ...companyMatch,
    ...roleMatch,
    ...locationMatch,
    ...applicationAction,
    ...jobStatus,
  });

  return {
    ...baseEvidence,
    ...companyMatch,
    ...roleMatch,
    ...locationMatch,
    ...applicationAction,
    ...jobStatus,
    overallConfidence,
    summary: '', // Will be filled by shouldVerify
  };
}

/**
 * Analyzes company match in page content.
 */
function analyzeCompanyMatch(
  lowerHtml: string,
  lowerText: string,
  url: string,
  company: string | null,
): Pick<ValidationEvidence, 'companyMatch' | 'companyMatchScore' | 'companySignals'> {
  if (!company) {
    return { companyMatch: false, companyMatchScore: 0, companySignals: [] };
  }

  const signals: string[] = [];
  let score = 0;

  const companyLower = company.toLowerCase();
  /* Generic corporate words are dropped: "Technologies" appears on half the
     careers pages on the internet, and letting it match would make every ATS page
     look like the right employer. */
  const companyTokens = companyLower
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !GENERIC_COMPANY_TOKENS.has(token));

  // Exact company name match (high value).
  if (lowerText.includes(companyLower)) {
    signals.push(`exact: "${company}"`);
    score += 40;
  }

  // Company tokens in page title (meta tag).
  const pageTitle = /<title[^>]*>([^<]+)<\/title>/i.exec(lowerHtml)?.[1]?.toLowerCase();
  if (pageTitle && companyTokens.some((token) => pageTitle.includes(token))) {
    signals.push('in page title');
    score += 30;
  }

  // Company in the URL — the host or the path naming the employer.
  const lowerUrl = url.toLowerCase();
  if (companyTokens.some((token) => lowerUrl.includes(token))) {
    signals.push('in URL');
    score += 20;
  }

  // Company in `og:site_name`, in either attribute order.
  const siteName = readMetaContent(lowerHtml, 'og:site_name');
  if (siteName !== null && companyTokens.some((token) => siteName.includes(token))) {
    signals.push('in og:site_name');
    score += 25;
  }

  return {
    companyMatch: score >= 40,
    companyMatchScore: Math.min(score, 100),
    companySignals: signals,
  };
}

/** Corporate suffixes and filler words that identify no particular employer. */
const GENERIC_COMPANY_TOKENS = new Set([
  'the',
  'inc',
  'ltd',
  'llc',
  'llp',
  'plc',
  'pvt',
  'private',
  'limited',
  'corp',
  'corporation',
  'company',
  'group',
  'global',
  'india',
  'technologies',
  'technology',
  'solutions',
  'services',
  'systems',
  'software',
  'labs',
  'consulting',
  'international',
]);

/**
 * Reads one `<meta>` tag's content, whichever order the attributes are in.
 *
 * The naive single regex only matches `property` before `content`, and real pages
 * emit both orders — so a page whose `og:site_name` names the employer would score
 * nothing at all. Matching the tag first and then reading each attribute out of it
 * is order-independent, and `[^>]` keeps the match inside one tag.
 */
function readMetaContent(lowerHtml: string, propertyName: string): string | null {
  const pattern = new RegExp(
    `<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${propertyName}["'][^>]*>|` +
      `<meta\\b[^>]*content\\s*=\\s*["'][^"']*["'][^>]*(?:property|name)\\s*=\\s*["']${propertyName}["'][^>]*>`,
    'i',
  );

  const tag = pattern.exec(lowerHtml)?.[0];
  if (tag === undefined) return null;

  const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const value = content?.[1] ?? content?.[2];

  return value === undefined || value.trim().length === 0 ? null : value.trim();
}

/**
 * Analyzes role match in page content.
 */
function analyzeRoleMatch(
  lowerHtml: string,
  lowerText: string,
  role: string | null,
): Pick<ValidationEvidence, 'roleMatch' | 'roleMatchScore' | 'roleSignals'> {
  if (!role) {
    return { roleMatch: false, roleMatchScore: 0, roleSignals: [] };
  }

  const signals: string[] = [];
  let score = 0;

  const roleLower = role.toLowerCase();
  const roleTokens = roleLower
    .split(/\s+/)
    .filter((t) => t.length > 2 && !['the', 'and', 'for'].includes(t));

  // Exact role match.
  if (lowerText.includes(roleLower)) {
    signals.push(`exact: "${role}"`);
    score += 50;
  }

  // Significant role tokens match (engineer, developer, analyst, etc.)
  const significantTokens = roleTokens.filter((t) =>
    /engineer|developer|analyst|manager|intern|designer|architect|scientist/i.test(t),
  );

  const matchingTokens = significantTokens.filter((token) => lowerText.includes(token));
  if (matchingTokens.length > 0) {
    signals.push(`tokens: ${matchingTokens.join(', ')}`);
    score += matchingTokens.length * 15;
  }

  // Role in page title.
  const pageTitle = /<title[^>]*>([^<]+)<\/title>/i.exec(lowerHtml)?.[1]?.toLowerCase();
  if (pageTitle && roleTokens.some((token) => pageTitle.includes(token))) {
    signals.push('in page title');
    score += 25;
  }

  return {
    roleMatch: score >= 40,
    roleMatchScore: Math.min(score, 100),
    roleSignals: signals,
  };
}

/**
 * Analyzes location compatibility.
 */
function analyzeLocationMatch(
  /* Location only ever appears in the page text, but the parameter is kept so
     every analyzer in this file takes the same (html, text, …) shape. */
  _lowerHtml: string,
  lowerText: string,
  location: string | null,
): Pick<ValidationEvidence, 'locationMatch' | 'locationSignals'> {
  if (!location) {
    // No location specified = compatible by default.
    return { locationMatch: true, locationSignals: ['not specified'] };
  }

  const signals: string[] = [];
  const locationLower = location.toLowerCase();
  const locationTokens = locationLower.split(/\s+|,/).filter((t) => t.length > 2);

  // Check for location mentions in content.
  if (lowerText.includes(locationLower)) {
    signals.push(`exact: "${location}"`);
    return { locationMatch: true, locationSignals: signals };
  }

  // Check for location tokens.
  const matchingTokens = locationTokens.filter((token) => lowerText.includes(token));
  if (matchingTokens.length > 0) {
    signals.push(`tokens: ${matchingTokens.join(', ')}`);
    return { locationMatch: true, locationSignals: signals };
  }

  // Remote/hybrid keywords make any location compatible.
  if (/\b(remote|hybrid|work from home|wfh|anywhere)\b/.test(lowerText)) {
    signals.push('remote/hybrid position');
    return { locationMatch: true, locationSignals: signals };
  }

  // No location match, but this is not a hard fail.
  return { locationMatch: false, locationSignals: ['not found on page'] };
}

/**
 * Detects application action on the page.
 */
function detectApplicationAction(
  lowerHtml: string,
  url: string,
): Pick<ValidationEvidence, 'hasApplicationAction' | 'applicationSignals'> {
  const signals: string[] = [];

  /* An interactive control whose own label says "apply" or "submit application".
     Bounded to `[^<]*` inside the element so the match cannot span from a button
     at the top of the page to the word "apply" in the footer — the unbounded
     `.*?apply.*?` version fired on nearly every careers page. */
  const actionPatterns: Array<[RegExp, string]> = [
    [/<button\b[^>]*>[^<]{0,60}\bapply\b/i, 'apply button'],
    [/<a\b[^>]*\bhref\b[^>]*>[^<]{0,60}\bapply\b/i, 'apply link'],
    [
      /<input\b[^>]*type\s*=\s*["']submit["'][^>]*value\s*=\s*["'][^"']*\bapply\b/i,
      'apply submit input',
    ],
    [/<form\b[^>]*\baction\s*=\s*["'][^"']*(?:apply|application)/i, 'form posts to an apply route'],
    [/\bdata-(?:automation|qa|testid)\s*=\s*["'][^"']*apply/i, 'apply control (test hook)'],
  ];

  for (const [pattern, label] of actionPatterns) {
    if (pattern.test(lowerHtml)) signals.push(label);
  }

  // A form that takes a CV or any file upload is an application form.
  if (
    /<form\b[^>]*>/i.test(lowerHtml) &&
    (/\bname\s*=\s*["'][^"']*(?:resume|cv|application)/i.test(lowerHtml) ||
      /\btype\s*=\s*["']file["']/i.test(lowerHtml))
  ) {
    signals.push('application form detected');
  }

  /* An ATS *host* is the signal, not the word "greenhouse" appearing in the
     markup. Matching the body text meant any page linking to an ATS — including an
     aggregator article — claimed to be an ATS application interface. */
  const host = hostOfUrl(url);
  if (host !== null && isTrustedAtsHost(host) && /\bapply|submit|application\b/i.test(lowerHtml)) {
    signals.push('ATS application interface');
  }

  /* A requisition id in the *URL* names one posting, so it is evidence about this
     page. The same string anywhere in the markup is not: `job_id` shows up in every
     listing page's own JavaScript. */
  if (/[?&/](?:job[_-]?id|position[_-]?id|req[_-]?id|jobid|requisition[_-]?id)[=/]/i.test(url)) {
    signals.push('posting id in url');
  }

  return {
    hasApplicationAction: signals.length > 0,
    applicationSignals: signals,
  };
}

/**
 * Detects job status indicators.
 */
function detectJobStatus(
  /* Closed/expired wording is prose, so only the stripped text is read here. */
  _lowerHtml: string,
  lowerText: string,
): Pick<ValidationEvidence, 'isJobActive' | 'statusSignals'> {
  const signals: string[] = [];

  // Negative indicators (job closed/expired).
  const closedPatterns = [
    /position.*?(?:filled|closed)/,
    /application.*?(?:closed|expired)/,
    /no longer.*?accepting/,
    /deadline.*?passed/,
    /this\s+(?:job|position|role).*?(?:expired|closed)/,
  ];

  for (const pattern of closedPatterns) {
    if (pattern.test(lowerText)) {
      signals.push('job appears closed/expired');
      return { isJobActive: false, statusSignals: signals };
    }
  }

  // Positive indicators (job open).
  if (/apply\s+now|accepting\s+applications|positions?\s+available/i.test(lowerText)) {
    signals.push('job appears active');
  }

  // Default to active if no clear closed indicators.
  return {
    isJobActive: true,
    statusSignals: signals.length > 0 ? signals : ['no closed indicators'],
  };
}

/**
 * Calculates overall confidence from all evidence.
 */
function calculateOverallConfidence(evidence: Partial<ValidationEvidence>): number {
  let confidence = 0;

  // Official source (required) - 30 points.
  if (evidence.isOfficialSource) confidence += 30;

  // Application action (required) - 30 points.
  if (evidence.hasApplicationAction) confidence += 30;

  // Company match - 20 points.
  if (evidence.companyMatch) confidence += 20;

  // Role match - 10 points.
  if (evidence.roleMatch) confidence += 10;

  // Location match - 5 points.
  if (evidence.locationMatch) confidence += 5;

  // Job active - 5 points.
  if (evidence.isJobActive) confidence += 5;

  return Math.min(confidence, 100);
}

/**
 * Decides whether to verify based on evidence.
 *
 * Requirements:
 * - MUST be official source
 * - MUST have application action
 * - MUST pass company check (match OR trusted ATS)
 * - MUST be active job
 */
function shouldVerify(evidence: ValidationEvidence): boolean {
  // Hard requirements.
  if (!evidence.isOfficialSource) return false;
  if (!evidence.hasApplicationAction) return false;
  if (!evidence.isJobActive) return false;

  // Company match: required for company careers, optional for trusted ATS.
  if (evidence.officialSourceType === 'company_careers' && !evidence.companyMatch) {
    return false;
  }

  // Overall confidence threshold: must be at least 70.
  if (evidence.overallConfidence < 70) return false;

  return true;
}

/**
 * Builds verification summary from evidence.
 */
function buildVerificationSummary(evidence: ValidationEvidence): string {
  const parts: string[] = [];

  if (evidence.officialSourceType === 'trusted_ats') {
    parts.push('trusted ATS');
  } else if (evidence.officialSourceType === 'company_careers') {
    parts.push('official company page');
  }

  if (evidence.companyMatch) {
    parts.push(`company matched (${evidence.companyMatchScore}%)`);
  }

  if (evidence.roleMatch) {
    parts.push(`role matched (${evidence.roleMatchScore}%)`);
  }

  if (evidence.hasApplicationAction) {
    parts.push('has application action');
  }

  return parts.join(', ');
}

/**
 * Builds rejection reason from evidence.
 */
function buildRejectionReason(evidence: ValidationEvidence): string {
  const failures: string[] = [];

  if (!evidence.isOfficialSource) failures.push('not official source');
  if (!evidence.hasApplicationAction) failures.push('no application action');
  if (!evidence.companyMatch && evidence.officialSourceType === 'company_careers') {
    failures.push('company mismatch');
  }
  if (!evidence.isJobActive) failures.push('job appears closed');
  if (evidence.overallConfidence < 70) {
    failures.push(`low confidence (${evidence.overallConfidence}%)`);
  }

  return failures.join(', ');
}

/**
 * Evidence for a URL rejected before its page was read.
 *
 * Every flag is "no evidence gathered", which is what these early exits mean —
 * including `isJobActive`, which is a claim about the *posting*. Recording `false`
 * there would assert the job is closed on the strength of never having looked,
 * and that assertion is stored on the job document where an admin reads it.
 */
function createEmptyEvidence(reason: string): ValidationEvidence {
  return {
    companyMatch: false,
    companyMatchScore: 0,
    companySignals: [],
    roleMatch: false,
    roleMatchScore: 0,
    roleSignals: [],
    locationMatch: false,
    locationSignals: [],
    hasApplicationAction: false,
    applicationSignals: [],
    isOfficialSource: false,
    officialSourceType: null,
    isJobActive: true,
    statusSignals: ['not checked'],
    overallConfidence: 0,
    summary: `not verified: ${reason}`,
  };
}

/**
 * Strips HTML tags to get plain text.
 */
function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
