/**
 * Thin client for the aggregator API.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time so it is readable from both
 * server and client components.
 */
const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL?.trim();

/* Fail the production build rather than ship a bundle that points at the
   developer's own machine. Because the value is inlined, an unset variable is not
   a runtime fallback a deployment could recover from: every visitor would get
   `http://localhost:4000`, which resolves to nothing on their machine and is
   blocked as mixed content by the HTTPS page anyway. Stopping here names the
   missing variable instead. Development keeps the localhost default so the
   project stays runnable with no configuration — the same split as the Clerk
   check in `lib/clerk.ts`. */
if (process.env.NODE_ENV === "production" && !configuredApiUrl) {
  throw new Error(
    "NEXT_PUBLIC_API_URL is not set. The browser bundle would fall back to " +
      "http://localhost:4000, so this build was stopped instead of producing a site " +
      "that cannot reach its API. Set it to the deployed API origin — for example " +
      "https://your-api.onrender.com (see apps/web/.env.example).",
  );
}

/**
 * Origin of the API, normalized without a trailing slash so everything built on
 * it — `apiUrl()` and the Socket.IO URL in `lib/socket.ts` — joins cleanly.
 */
export const API_BASE_URL = (configuredApiUrl ?? "http://localhost:4000").replace(/\/+$/, "");

export interface ApiHealth {
  status: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
  database: {
    status: string;
    connected: boolean;
  };
}

/**
 * A job exactly as the public API returns it.
 *
 * There is nothing here about where a posting came from: no channel, no message
 * id, no raw Telegram text. `description` is the sanitized post — the backend
 * strips channel promotion during ingestion, so the client renders it as-is and
 * never has to filter anything for display.
 */
export interface PublicJob {
  id: string;
  company: string | null;
  role: string | null;
  batch: string | null;
  /** The apply link exactly as published. Never rewritten client-side. */
  applyUrl: string | null;
  location: string | null;
  employmentType: string | null;
  description: string;
  postedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobsPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface JobsResponse {
  data: PublicJob[];
  pagination: JobsPagination;
}

export interface FetchJobsParams {
  page?: number;
  limit?: number;
  search?: string;
  batch?: string;
  type?: string;
  /** Matched against the posting's stored location text. */
  location?: string;
  /**
   * Inclusive `postedAt` bounds, as ISO instants.
   *
   * The window is computed here rather than named ("today", "last 7 days")
   * because only the browser knows which timezone the reader is in — see
   * `lib/job-filters.ts`. The API just applies the range it is given.
   */
  postedFrom?: string;
  postedTo?: string;
  sort?: "newest" | "oldest";
}

/** Joins a path onto the API base URL without doubling or dropping slashes. */
export function apiUrl(path: string): string {
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${suffix}`;
}

export async function fetchApiHealth(signal?: AbortSignal): Promise<ApiHealth> {
  const response = await fetch(apiUrl("/health"), {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`API responded with ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as ApiHealth;
}

export async function fetchJobs(
  params?: FetchJobsParams,
  signal?: AbortSignal,
): Promise<JobsResponse> {
  const query = new URLSearchParams();

  if (params?.page !== undefined && params.page > 0) {
    query.set("page", params.page.toString());
  }
  if (params?.limit !== undefined && params.limit > 0) {
    query.set("limit", params.limit.toString());
  }
  if (params?.search && params.search.trim()) {
    query.set("search", params.search.trim());
  }
  if (params?.batch && params.batch.trim()) {
    query.set("batch", params.batch.trim());
  }
  if (params?.type && params.type.trim()) {
    query.set("type", params.type.trim());
  }
  if (params?.location && params.location.trim()) {
    query.set("location", params.location.trim());
  }
  if (params?.postedFrom) {
    query.set("postedFrom", params.postedFrom);
  }
  if (params?.postedTo) {
    query.set("postedTo", params.postedTo);
  }
  if (params?.sort) {
    query.set("sort", params.sort);
  }

  const queryString = query.toString();
  const endpoint = queryString ? `/api/v1/jobs?${queryString}` : "/api/v1/jobs";

  const response = await fetch(apiUrl(endpoint), {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`API responded with ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as JobsResponse;
}

/**
 * Note: there is deliberately no channel listing here. Source channels are
 * internal and readable only through the admin API, so the public filter bar has
 * no Source dropdown to populate.
 */
export async function fetchJob(id: string, signal?: AbortSignal): Promise<PublicJob> {
  const response = await fetch(apiUrl(`/api/v1/jobs/${encodeURIComponent(id)}`), {
    signal,
    headers: { Accept: "application/json" },
  });

  if (response.status === 404) {
    throw Object.assign(new Error("Job not found"), { status: 404 });
  }

  if (!response.ok) {
    throw new Error(`API responded with ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as { data: PublicJob };
  return body.data;
}
