/**
 * Candidate profile + recommendations client.
 *
 * The profile is owned by a bearer token the API mints on the first resume
 * upload. It lives in localStorage because it is the only thing identifying the
 * profile, and it is sent as `Authorization: Bearer` on every profile call.
 */

import { apiUrl } from "@/lib/api";

/** localStorage key holding the profile bearer token. */
const TOKEN_KEY = "jia.profileToken";

/** The employment types the API accepts, in the order the UI offers them. */
export const JOB_TYPE_OPTIONS = [
  { value: "internship", label: "Internship" },
  { value: "full-time", label: "Full-Time" },
  { value: "part-time", label: "Part-Time" },
  { value: "contract", label: "Contract" },
  { value: "apprenticeship", label: "Apprenticeship" },
  { value: "training", label: "Training" },
] as const;

export interface CandidateProfile {
  skills: string[];
  preferredRoles: string[];
  preferredLocations: string[];
  preferredJobTypes: string[];
  experienceYears: number | null;
  graduationYear: string | null;
  /** Display name of the last resume parsed. Never a URL — none is stored. */
  resumeFileName: string | null;
  resumeParsedAt: string | null;
  hasResume: boolean;
  /** Fields edited by hand, which a later resume upload will not overwrite. */
  manualFields: string[];
}

/**
 * A recommended job, exactly as the jobs API describes one.
 *
 * `applyUrl` is the stored application link, passed through untouched — the UI
 * links to it and never rewrites it.
 */
export interface RecommendedJob {
  id: string;
  company: string | null;
  role: string | null;
  batch: string | null;
  applyUrl: string | null;
  location: string | null;
  employmentType: string | null;
  description: string;
  postedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Recommendation {
  job: RecommendedJob;
  /** 0–100, computed by the API's deterministic matcher. */
  matchScore: number;
  matchedSkills: string[];
  /** Why this job matched, written by the matching engine. */
  reasons: string[];
  /** Skills the job asks for that the profile does not list. */
  gaps: string[];
}

export interface RecommendationsResponse {
  data: Recommendation[];
  meta: { minScore: number; considered: number; hasPreferences: boolean };
}

/** Editable preference fields, for a partial update. */
export type ProfileUpdate = Partial<{
  skills: string[];
  preferredRoles: string[];
  preferredLocations: string[];
  preferredJobTypes: string[];
  experienceYears: number | null;
  graduationYear: string | null;
}>;

/** An API error carrying the status, so callers can tell 401 from 500. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/* ── Token storage ────────────────────────────────────────────────────────── */

export function readProfileToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private-mode or blocked storage: treated as "no profile yet".
    return null;
  }
}

function writeProfileToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Nothing to do — the upload still succeeded for this page view.
  }
}

export function clearProfileToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore.
  }
}

/* ── Requests ─────────────────────────────────────────────────────────────── */

function authHeaders(): Record<string, string> {
  const token = readProfileToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Reads the API's `{ error: { message } }` body so the UI can show the server's
 * own wording — which is where the useful PDF and parsing messages live.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let message = `Request failed with ${response.status}`;

  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (typeof body.error?.message === "string" && body.error.message.length > 0) {
      message = body.error.message;
    }
  } catch {
    // Non-JSON error body: keep the status-based message.
  }

  return new ApiError(message, response.status);
}

/**
 * Uploads a resume PDF and returns the parsed profile.
 *
 * The PDF is sent as the raw request body. On the first upload the API replies
 * with a token, which is stored here so every later call is authenticated.
 */
export async function uploadResume(file: File, signal?: AbortSignal): Promise<CandidateProfile> {
  const response = await fetch(apiUrl("/api/v1/profile/resume"), {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/pdf",
      "X-Resume-Filename": file.name,
      Accept: "application/json",
      ...authHeaders(),
    },
    body: file,
  });

  if (!response.ok) throw await toApiError(response);

  const body = (await response.json()) as { data: CandidateProfile; token?: string };
  if (typeof body.token === "string") writeProfileToken(body.token);

  return body.data;
}

/** The caller's profile, or null when there is no token or it is unknown. */
export async function fetchProfile(signal?: AbortSignal): Promise<CandidateProfile | null> {
  if (readProfileToken() === null) return null;

  const response = await fetch(apiUrl("/api/v1/profile"), {
    signal,
    headers: { Accept: "application/json", ...authHeaders() },
  });

  if (response.status === 401) {
    // The token no longer resolves (e.g. the database was reset). Drop it so the
    // UI falls back to the upload prompt instead of looping on a dead token.
    clearProfileToken();
    return null;
  }

  if (!response.ok) throw await toApiError(response);

  const body = (await response.json()) as { data: CandidateProfile };
  return body.data;
}

export async function updateProfile(
  update: ProfileUpdate,
  signal?: AbortSignal,
): Promise<CandidateProfile> {
  const response = await fetch(apiUrl("/api/v1/profile"), {
    method: "PUT",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify(update),
  });

  if (!response.ok) throw await toApiError(response);

  const body = (await response.json()) as { data: CandidateProfile };
  return body.data;
}

/**
 * The caller's recommendations, or null when no profile token is stored.
 *
 * Same contract as `fetchProfile`: "no profile yet" is data, not an error, so
 * the page can show the upload prompt without sending an anonymous request that
 * could only ever come back 401.
 */
export async function fetchRecommendations(
  signal?: AbortSignal,
  limit = 20,
): Promise<RecommendationsResponse | null> {
  if (readProfileToken() === null) return null;

  const response = await fetch(apiUrl(`/api/v1/jobs/recommended?limit=${limit}`), {
    signal,
    headers: { Accept: "application/json", ...authHeaders() },
  });

  if (response.status === 401) {
    // The token no longer resolves; drop it so the UI falls back to the upload
    // prompt instead of looping on a dead token.
    clearProfileToken();
    return null;
  }

  if (!response.ok) throw await toApiError(response);

  return (await response.json()) as RecommendationsResponse;
}
