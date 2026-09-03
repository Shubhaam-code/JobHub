import type { PublicJob } from "@/lib/api";
import type { CandidateProfile } from "@/lib/profile";

export interface JobMatch {
  score: number | null;
  reasons: string[];
}

const GENERIC_ROLE_WORDS = new Set([
  "developer",
  "engineer",
  "intern",
  "internship",
  "trainee",
  "analyst",
  "associate",
  "junior",
  "senior",
  "role",
  "the",
  "and",
  "of",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
}

function hasTerm(text: string, term: string): boolean {
  const haystack = ` ${normalize(text)} `;
  const needle = normalize(term);
  return needle.length > 0 && haystack.includes(` ${needle} `);
}

function roleWords(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length > 1 && !GENERIC_ROLE_WORDS.has(word));
}

function scoreJobType(profile: CandidateProfile, job: PublicJob): number | null {
  if (profile.preferredJobTypes.length === 0 || !job.employmentType) return null;
  const type = normalize(job.employmentType);
  return profile.preferredJobTypes.some((preferred) => type === normalize(preferred)) ? 1 : 0;
}

function requiredExperience(text: string): number | null {
  const fresher = /\b(fresher|freshers|no experience|0 experience)\b/i.test(text);
  if (fresher) return 0;
  const match = /\b(\d{1,2})\s*(?:\+|to|-)?\s*(?:\d{1,2})?\s*(?:years?|yrs?)\b/i.exec(text);
  return match ? Number(match[1]) : null;
}

export function matchJob(profile: CandidateProfile | null, job: PublicJob): JobMatch {
  if (!profile) return { score: null, reasons: [] };

  const text = [job.role, job.company, job.location, job.employmentType, job.description]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(" ");
  const dimensions: { ratio: number; weight: number; reason?: string }[] = [];

  if (profile.skills.length > 0) {
    const matched = profile.skills.filter((skill) => hasTerm(text, skill));
    dimensions.push({
      ratio: matched.length / profile.skills.length,
      weight: 50,
      reason:
        matched.length > 0
          ? `${matched.length}/${profile.skills.length} of your listed skills appear in this job`
          : "✕ No relevant skills matched",
    });
  }

  if (profile.preferredRoles.length > 0 && job.role) {
    const best = Math.max(
      ...profile.preferredRoles.map((preferred) => {
        const words = roleWords(preferred);
        return words.length === 0
          ? hasTerm(job.role ?? "", preferred)
            ? 1
            : 0
          : words.filter((word) => hasTerm(job.role ?? "", word)).length / words.length;
      }),
    );
    dimensions.push({
      ratio: best,
      weight: 20,
      reason:
        best >= 0.5
          ? "Role is close to your preferred role"
          : "✕ Role has low similarity to your preferred role",
    });
  }

  if (profile.preferredLocations.length > 0 && job.location) {
    const matches = profile.preferredLocations.some((location) =>
      hasTerm(job.location ?? "", location),
    );
    dimensions.push({
      ratio: matches ? 1 : 0,
      weight: 15,
      reason: matches
        ? "Location matches your preference"
        : "✕ Location differs from your preference",
    });
  }

  const typeScore = scoreJobType(profile, job);
  if (typeScore !== null)
    dimensions.push({
      ratio: typeScore,
      weight: 10,
      reason:
        typeScore === 1
          ? "Job type matches your preference"
          : "✕ Job type differs from your preference",
    });

  if (profile.experienceYears !== null) {
    const required = requiredExperience(text);
    if (required !== null) {
      const fits = profile.experienceYears >= required;
      dimensions.push({
        ratio: fits ? 1 : 0,
        weight: 5,
        reason: fits ? "Experience level matches" : "✕ Required experience is higher than yours",
      });
    }
  }

  if (dimensions.length === 0) return { score: null, reasons: [] };
  const available = dimensions.reduce((sum, item) => sum + item.weight, 0);
  const score = Math.round(
    (dimensions.reduce((sum, item) => sum + item.ratio * item.weight, 0) / available) * 100,
  );
  return {
    score,
    reasons: dimensions
      .map((item) => item.reason)
      .filter((reason): reason is string => Boolean(reason))
      .slice(0, 5),
  };
}
