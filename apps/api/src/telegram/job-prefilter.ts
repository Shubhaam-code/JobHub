/**
 * Lightweight local pre-filter that runs BEFORE the LLM.
 *
 * Its only job is to keep obviously useless posts ("Good morning", "Join our
 * channel") from costing an LLM call. It is deliberately permissive: the LLM is
 * the actual classifier, so anything that could plausibly be an opportunity is
 * allowed through. Channel-agnostic — no channel names appear here.
 */

/**
 * Any hint that a post might be about work: hiring language, role words,
 * eligibility words, or compensation words. One match is enough to reach the LLM.
 */
const JOB_SIGNAL_REGEX = new RegExp(
  [
    // Hiring / recruitment language
    'hiring',
    'hire[sd]?',
    'recruit\\w*',
    'vacanc(?:y|ies)',
    'opening[s]?',
    'opportunit(?:y|ies)',
    'job[s]?',
    'work\\s*from\\s*home',
    '\\bwfh\\b',
    'walk[\\s-]*in',
    'placement',
    'off[\\s-]*campus',
    'on[\\s-]*campus',
    'campus\\s*drive',
    'drive',
    'career[s]?',
    'employment',
    'apply',
    'application[s]?',
    'registration',
    'register',
    'referral',
    // Role words
    'intern(?:ship)?[s]?',
    'fresher[s]?',
    'graduate[s]?',
    'trainee',
    'apprentice(?:ship)?',
    'engineer(?:ing)?',
    'developer',
    'analyst',
    'scientist',
    'designer',
    'consultant',
    'architect',
    'programmer',
    'tester',
    'associate',
    'executive',
    'specialist',
    'technician',
    'manager',
    // `\d?` so "SDE1"/"SWE2" still register.
    '\\bsde\\d?\\b',
    '\\bswe\\d?\\b',
    '\\bsdet\\b',
    '\\bqa\\b',
    'devops',
    'full\\s*stack',
    'frontend',
    'backend',
    // Eligibility / compensation words
    'batch',
    'eligibilit(?:y|ies)',
    'eligible',
    'stipend',
    'salary',
    '\\bctc\\b',
    '\\blpa\\b',
    'experience\\s*:',
    'last\\s*date',
    'deadline',
    // More role/domain words
    'data\\s*science',
    'machine\\s*learning',
    'artificial\\s*intelligence',
    'ml\\s*engineer',
    'data\\s*engineer',
    'data\\s*analyst',
    'product\\s*manager',
    'ui\\s*/\\s*ux',
    'cyber\\s*security',
    'network\\s*engineer',
    'system\\s*admin',
    'cloud',
    'java',
    'python',
    'react',
    'node',
    'angular',
    'sql',
    // Indian job market specific.
    //
    // Acronyms and degree abbreviations are the one group that needs \b anchors:
    // unanchored, "b.?e" and "b.?sc" both match inside "Subscribe", so a pure
    // "Subscribe to t.me/..." promo would score a job signal and buy an LLM call.
    // Longer words above can stay unanchored — matching inside a longer word
    // ("javascript", "internships") is the permissive behaviour we want.
    '\\bb\\.?tech\\b',
    '\\bm\\.?tech\\b',
    '\\bb\\.?e\\b',
    '\\bb\\.?sc\\b',
    '\\bmca\\b',
    '\\bbca\\b',
    '\\bmba\\b',
    'notification',
    'requirement[s]?',
    'qualification[s]?',
    'joining',
    'selection',
    'shortlist',
    'interview',
    'aptitude',
    'package',
    'urgent',
    'immediate',
    'walk\\s*-?\\s*in',
    // Qualified only: a bare "alert" also matches "Follow us for instant alerts",
    // which is promotion, not an opportunity.
    'hiring\\s*alert',
    'job\\s*alert',
    'experience[d]?',
  ].join('|'),
  'i',
);

/**
 * Posts that are nothing but a channel/collab/greeting CTA. Only used to skip
 * text that carries NO job signal at all, so a promo line appended to a real
 * job post can never cause a skip.
 */
const PURE_NOISE_REGEX =
  /(\bjoin\b|\bsubscribe\b|\bfollow\b|\bshare\b|\bdm\b|\bcollab\w*|\bpromot\w*|\badvertis\w*|good\s*(?:morning|evening|night)|t\.me\/|telegram\.me\/|telegram\.dog\/|whats\s*app)/i;

/** Below this length a post cannot describe an opportunity in any format. */
const MIN_USEFUL_LENGTH = 15;

export interface PrefilterResult {
  /** True when the post should be handed to the LLM. */
  send: boolean;
  /** Set when `send` is false — a short, log-friendly reason. */
  reason?: string;
}

/**
 * Decides whether a post is worth an LLM call.
 *
 * Skips only three things: empty/near-empty text, text with no work-related
 * word anywhere, and pure promotion CTAs. Everything else — including anything
 * ambiguous — is sent on to the LLM.
 */
export function prefilterMessage(text: string): PrefilterResult {
  const trimmed = text?.trim() ?? '';

  if (trimmed.length === 0) {
    return { send: false, reason: 'no text' };
  }

  const hasJobSignal = JOB_SIGNAL_REGEX.test(trimmed);

  // A job signal always wins, even when the post also carries promo lines.
  if (hasJobSignal) {
    return { send: true };
  }

  if (trimmed.length < MIN_USEFUL_LENGTH) {
    return { send: false, reason: 'too short, no job signal' };
  }

  if (PURE_NOISE_REGEX.test(trimmed)) {
    return { send: false, reason: 'promotion/greeting only' };
  }

  return { send: false, reason: 'no job signal' };
}
