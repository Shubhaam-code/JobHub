/**
 * Utilities for cleaning and extracting genuine job information from Telegram posts.
 *
 * Removes all promotional noise, channel links, social links, and CTAs while
 * extracting structured job specifications (Location, Salary, Experience,
 * Eligibility, Skills, Deadline, genuine job descriptions, and application emails).
 */

import { type ResolvedLink } from "./links";
import type { PublicJob } from "./api";

/**
 * Chat/social domains whose links must never appear in visible job content.
 *
 * LinkedIn is deliberately absent: a LinkedIn job or company page is a genuine
 * application destination, so blocking it would remove a working Apply link.
 */
const BLOCKED_LINK_HOSTS = [
  "t.me",
  "telegram.me",
  "telegram.dog",
  "telegram.org",
  "wa.me",
  "whatsapp.com",
  "youtube.com",
  "youtu.be",
  "instagram.com",
  "instagr.am",
  "facebook.com",
  "fb.com",
  "fb.me",
  "discord.gg",
  "discord.com",
  "twitter.com",
  "x.com",
  "threads.net",
  "reddit.com",
];

const HOST_ALTERNATION = BLOCKED_LINK_HOSTS.map((host) => host.replace(/\./g, "\\.")).join("|");

/** Any subdomain of a blocked host — `chat.whatsapp.com`, `www.youtube.com`, `m.youtu.be`. */
const BLOCKED_HOST_PART = `(?:[a-z0-9-]+\\.)*(?:${HOST_ALTERNATION})`;
const BLOCKED_PATH_PART = "(?:\\/[^\\s<>()\\[\\]{}\"'`]*)?";

/**
 * A blocked link anywhere in a line, with or without a scheme.
 *
 * Group 1 is the character in front of the URL. It is required — and put back by
 * the replacement — for two reasons. It stops `t.me` matching inside an ordinary
 * word such as `content.method`, and it anchors the match ahead of the scheme so
 * the whole of `https://t.me/x` is removed rather than leaving a stranded
 * `https:` behind in the visible text.
 */
const BLOCKED_LINK_REGEX = new RegExp(
  `(^|[^A-Za-z0-9@._-])(?:(?:https?:)?\\/\\/)?${BLOCKED_HOST_PART}${BLOCKED_PATH_PART}`,
  "gi",
);

/** A line that is nothing but a blocked link. */
const BLOCKED_LINK_ONLY_REGEX = new RegExp(
  `^(?:(?:https?:)?\\/\\/)?${BLOCKED_HOST_PART}${BLOCKED_PATH_PART}$`,
  "i",
);

/** The platforms whose promotional prose is dropped along with their links. */
const PLATFORM_WORDS = "whatsapp|telegram|youtube|instagram|facebook|discord";

/** Promotional handle pattern like @channel, @admin, @careers */
const PROMO_HANDLE_REGEX = /(?:^|\s)@([A-Za-z0-9_]{3,32})\b/g;

/** Promotional and CTA line matchers. */
const PROMOTIONAL_LINE_PATTERNS = [
  /\bjoin\s+(?:our|the|this|us|now)?\s*(?:telegram|channel|group|whatsapp|community|network|family|batch|page)\b/i,
  /\bfollow\s+(?:us|our|page|channel|on|for\s+more)\b/i,
  /\bsubscribe\s+(?:to|our|now|for|channel|youtube)?\b/i,
  /\b(?:dm|message)\s+(?:for|here|me|us|to)\s*(?:paid\s+)?(?:promo|promotion|collab|collaboration|queries|query|business|advertis\w*|sponsor\w*)\b/i,
  /\b(?:for\s+)?(?:paid\s+)?(?:promotions?|collabs?|collaborations?|advertis\w*|sponsor\w*)\b/i,
  /\bshare\s+(?:with|to)\s+(?:your\s+)?(?:friends|groups|batchmates|colleagues|contacts)\b/i,
  /\bdaily\s+(?:job|internship|hiring|tech|off-campus)\s+updates\b/i,
  /\bstay\s+tuned\b/i,
  /\bclick\s+(?:here\s+)?to\s+join\b/i,
  /\btap\s+(?:here\s+)?to\s+join\b/i,
  /\bget\s+hired\b/i,
  /\blike\s*,\s*share\b/i,
  /\bimportant\s+links?\s*[:\-]?\s*$/i,
  /\bwhatsapp\s+groups?\b/i,
  /\btelegram\s+channel\b/i,
  /\blinkedin\s+page\b/i,
  /\binstagram\s+page\b/i,
  /\b(?:all\s+the\s+best|best\s+of\s+luck|happy\s+applying)\b/i,

  /* The three shapes channel promotion actually takes: a platform next to a CTA
     verb, a platform next to a community noun, or a platform name on its own as
     a label for the link that sits after it. */
  new RegExp(
    `\\b(?:join|follow|subscribe|share|forward|visit|watch|check|ping|dm|connect)\\b[^\\n]{0,30}?\\b(?:${PLATFORM_WORDS})\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:${PLATFORM_WORDS})\\b[^\\n]{0,24}?\\b(?:group|groups|channel|channels|community|communities|page|link|links|handle|invite)\\b`,
    "i",
  ),
  new RegExp(
    `\\b(?:group|channel|community|page|invite)\\s*(?:link)?\\s*[:\\-\u2013\u2014]\\s*(?:${PLATFORM_WORDS})\\b`,
    "i",
  ),
  new RegExp(
    `^(?:${PLATFORM_WORDS})\\s*(?:group|channel|community|page|link)?\\s*[:\\-\u2013\u2014]?\\s*$`,
    "i",
  ),

  /* What a stripped promo line leaves behind once its link is gone: a bare CTA
     word, or a label whose only value was that link. */
  /^(?:join|follow|subscribe|share|watch|visit|click|tap|dm|contact|apply|application|regist(?:er|ration)|links?|forms?|website)\b[\s:\-\u2013\u2014]*$/i,
];

/** Check if a line is purely promotional or CTA noise. */
export function isPromotionalLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;

  // Pure divider or border lines
  if (/^[-=_*~•·#—–]{2,}$/.test(trimmed)) return true;

  // Pure handle, or a line that is only a chat/social link
  if (/^@[\w]+$/.test(trimmed)) return true;
  if (BLOCKED_LINK_ONLY_REGEX.test(trimmed)) return true;

  // Social / Telegram handles and promotional CTAs
  for (const pattern of PROMOTIONAL_LINE_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }

  return false;
}

/** Strip promotional URLs, handles, and CTA fragments from a string. */
export function sanitizeLineText(text: string): string {
  let cleaned = text.replace(BLOCKED_LINK_REGEX, "$1").replace(PROMO_HANDLE_REGEX, "").trim();

  // Strip leading decorative bullet symbols / emojis
  cleaned = cleaned.replace(/^[\s🔹▪️•\-*👉📌📍📢🔥🚀✨💰🎓🏢💼]+\s*/u, "");

  // Punctuation orphaned by a removed link: `Apply ()`, `Details -`, `a | b |`.
  cleaned = cleaned
    .replace(/\(\s*\)|\[\s*\]|\{\s*\}|<\s*>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[|,;•·\u2013\u2014-]+\s*$/, "")
    .trim();

  // Clean empty link labels left behind
  cleaned = cleaned.replace(
    /^(?:apply\s+link|registration\s+link|apply\s+here|link)\s*[:\-]\s*$/i,
    "",
  );

  return cleaned.trim();
}

/** Promotional email detection to reject ad/collab emails. */
const PROMO_EMAIL_REGEX =
  /(?:promo|promotion|sponsor|collab|collaboration|advertise|business|ads)@/i;

export interface CleanJobDetails {
  company: string | null;
  role: string | null;
  batch: string | null;
  location: string | null;
  employmentType: string | null;
  salary: string | null;
  experience: string | null;
  eligibility: string | null;
  skills: string | null;
  deadline: string | null;
  applyEmail: string | null;
  cleanDescription: string | null;
  cleanBullets: string[];
}

/**
 * Parses and cleans job details from the job model and its description.
 *
 * `description` is the sanitized post the public API returns — the backend has
 * already stripped channel promotion from it. The cleaning below is defence in
 * depth, and still does the real work of pulling structured fields out of prose.
 */
export function extractCleanJobDetails(job: PublicJob): CleanJobDetails {
  const lines = (job.description || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let extractedCompany: string | null = null;
  let extractedRole: string | null = null;
  let extractedBatch: string | null = null;
  let extractedLocation: string | null = null;
  let extractedType: string | null = null;
  let extractedSalary: string | null = null;
  let extractedExperience: string | null = null;
  let extractedEligibility: string | null = null;
  let extractedSkills: string | null = null;
  let extractedDeadline: string | null = null;
  let extractedApplyEmail: string | null = null;

  const descriptionLines: string[] = [];
  const bullets: string[] = [];

  // Patterns for structured key-value extraction
  const FIELD_PATTERNS = [
    {
      key: "company",
      regex: /^(?:company|organization|employer|hiring\s+company)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedCompany) extractedCompany = v;
      },
    },
    {
      key: "role",
      regex:
        /^(?:role|position|job\s+title|job\s+profile|profile|designation|post)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedRole) extractedRole = v;
      },
    },
    {
      key: "batch",
      regex:
        /^(?:batch|eligible\s+batch|passing\s+year|passout\s+year|graduation\s+year|year\s+of\s+passing)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedBatch) extractedBatch = v;
      },
    },
    {
      key: "location",
      regex:
        /^(?:location|job\s+location|work\s+location|office\s+location|posting\s+location)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedLocation) extractedLocation = v;
      },
    },
    {
      key: "type",
      regex: /^(?:employment\s+type|job\s+type|work\s+mode|job\s+nature|mode)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedType) extractedType = v;
      },
    },
    {
      key: "salary",
      regex: /^(?:salary|stipend|ctc|package|compensation|expected\s+ctc|pay)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedSalary) extractedSalary = v;
      },
    },
    {
      key: "experience",
      regex: /^(?:experience|exp|experience\s+required|target\s+experience)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedExperience) extractedExperience = v;
      },
    },
    {
      key: "eligibility",
      regex:
        /^(?:eligibility|qualification|qualifications|education|eligible\s+degree|degree|degrees|branch|eligible\s+branch|criteria|academic\s+criteria)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedEligibility) extractedEligibility = v;
      },
    },
    {
      key: "skills",
      regex:
        /^(?:skills|skills\s+required|key\s+skills|technical\s+skills|skill\s+set|desired\s+skills|tech\s+stack)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedSkills) extractedSkills = v;
      },
    },
    {
      key: "deadline",
      regex:
        /^(?:last\s+date|deadline|apply\s+by|last\s+date\s+to\s+apply|registration\s+deadline|valid\s+till)\s*[:\-]\s*(.+)$/i,
      setter: (v: string) => {
        if (!extractedDeadline) extractedDeadline = v;
      },
    },
  ];

  for (const rawLine of lines) {
    if (isPromotionalLine(rawLine)) {
      continue;
    }

    const cleanedLine = sanitizeLineText(rawLine);
    // Re-checked after stripping: removing a blocked link can turn a line that
    // read as genuine ("Telegram: https://t.me/x") into the bare promo label
    // underneath it, which should not survive into the description box.
    if (!cleanedLine || isPromotionalLine(cleanedLine)) continue;

    // Check for email
    const emailMatch = cleanedLine.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
    if (emailMatch && emailMatch[1]) {
      const email = emailMatch[1];
      if (!PROMO_EMAIL_REGEX.test(email) && !extractedApplyEmail) {
        extractedApplyEmail = email;
      }
    }

    // Try key-value match
    let matchedKey = false;
    for (const field of FIELD_PATTERNS) {
      const match = cleanedLine.match(field.regex);
      if (match && match[1]) {
        const val = sanitizeLineText(match[1]);
        if (val && !isPromotionalLine(val)) {
          field.setter(val);
          matchedKey = true;
          break;
        }
      }
    }

    if (matchedKey) continue;

    // Check if line is an apply URL line (e.g. "Apply here: https://...")
    if (
      /^(?:apply|registration|register|apply\s+online|link)\s*[:\-]?\s*(https?:\/\/.*)?$/i.test(
        cleanedLine,
      )
    ) {
      continue;
    }

    // Check if line starts as a bullet point
    if (/^[•\-*]/.test(rawLine)) {
      bullets.push(cleanedLine);
    } else {
      descriptionLines.push(cleanedLine);
    }
  }

  // Fallback / merge with structured data already extracted by LLM / API
  const company = job.company?.trim() || extractedCompany || null;
  const role = job.role?.trim() || extractedRole || null;
  const batch = job.batch?.trim() || extractedBatch || null;
  const location = job.location?.trim() || extractedLocation || null;
  const employmentType = job.employmentType?.trim() || extractedType || null;

  // Filter out redundant description lines that only repeat the company name or role headline
  const filteredDescriptionLines = descriptionLines.filter((l) => {
    if (company && l.toLowerCase() === company.toLowerCase()) return false;
    if (role && l.toLowerCase() === role.toLowerCase()) return false;
    if (
      company &&
      role &&
      l.toLowerCase().includes(company.toLowerCase()) &&
      l.toLowerCase().includes(role.toLowerCase()) &&
      l.length < 80
    ) {
      return false;
    }
    return true;
  });

  const cleanDescription =
    filteredDescriptionLines.length > 0 ? filteredDescriptionLines.join("\n\n") : null;

  return {
    company,
    role,
    batch,
    location,
    employmentType,
    salary: extractedSalary,
    experience: extractedExperience,
    eligibility: extractedEligibility,
    skills: extractedSkills,
    deadline: extractedDeadline,
    applyEmail: extractedApplyEmail,
    cleanDescription,
    cleanBullets: bullets,
  };
}

/**
 * Validates if an apply URL is safe and not a Telegram/WhatsApp chat link or social page.
 */
export function isGenuineApplyLink(link: ResolvedLink | null): boolean {
  if (!link) return false;
  if (link.kind === "email") {
    return !PROMO_EMAIL_REGEX.test(link.text);
  }
  try {
    const url = new URL(link.href);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    if (BLOCKED_LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
