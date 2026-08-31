/**
 * Thin client for the aggregator API.
 *
 * `NEXT_PUBLIC_API_URL` is inlined at build time so it is readable from both
 * server and client components.
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
}

/** Joins a path onto the API base URL without doubling or dropping slashes. */
export function apiUrl(path: string): string {
  const base = API_BASE_URL.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
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
