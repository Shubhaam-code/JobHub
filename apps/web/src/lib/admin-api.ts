/**
 * Admin API client — deliberately separate from `lib/api.ts`.
 *
 * `lib/api.ts` is the public client and knows nothing about Telegram. Everything
 * that names a channel lives here, behind a bearer token, so the split in the
 * code mirrors the split in the API: this module's endpoints all sit behind the
 * server's ADMIN check.
 *
 * The token is stored in localStorage, like the profile token. That is not what
 * protects the dashboard — the server rejects a non-ADMIN caller with 403
 * regardless of what the browser holds. It only saves re-typing the password.
 */

import { apiUrl } from "@/lib/api";

/** localStorage key holding the admin bearer token. */
const TOKEN_KEY = "jia.adminToken";

export type ChannelStatus = "active" | "paused";

/**
 * One row of the channel table.
 *
 * `id` is null for a channel that has ingestion history but no registry
 * document — it can be reported but not paused, because there is no row to flip.
 */
export interface AdminChannel {
  id: string | null;
  name: string;
  username: string;
  telegramId: string | null;
  status: ChannelStatus;
  /** Present in TELEGRAM_CHANNELS right now. */
  configured: boolean;
  messagesReceived: number;
  jobsExtracted: number;
  jobsProcessed: number;
  messagesPending: number;
  messagesFailed: number;
  /** Live count from the jobs collection, not a stored counter. */
  jobsInDatabase: number;
  lastMessageAt: string | null;
  lastSyncAt: string | null;
  pausedAt: string | null;
}

export interface AdminStats {
  channels: { total: number; active: number; paused: number; configured: number };
  messages: { received: number; processed: number; pending: number; failed: number };
  jobs: { extracted: number; inDatabase: number };
  queue: {
    pending: number;
    processing: number;
    completed: number;
    retry_wait: number;
    failed: number;
    total: number;
  };
  lastMessageAt: string | null;
  lastSyncAt: string | null;
  ingestion: {
    telegramConfigured: boolean;
    llmConfigured: boolean;
    queueWorkerEnabled: boolean;
  };
}

export interface AdminUser {
  id: string;
  email: string;
  role: "USER" | "ADMIN";
}

/** Carries the status so the UI can tell 401 (sign in) from 403 (not an admin). */
export class AdminApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
  }
}

/* ── Token storage ────────────────────────────────────────────────────────── */

export function readAdminToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    // Private-mode or blocked storage: treated as "not signed in".
    return null;
  }
}

function writeAdminToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Nothing to do — the session still works for this page view.
  }
}

export function clearAdminToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore.
  }
}

/* ── Requests ─────────────────────────────────────────────────────────────── */

function authHeaders(): Record<string, string> {
  const token = readAdminToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Reads the API's `{ error: { message } }` body so the server's wording shows. */
async function toAdminApiError(response: Response): Promise<AdminApiError> {
  let message = `Request failed with ${response.status}`;

  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (typeof body.error?.message === "string" && body.error.message.length > 0) {
      message = body.error.message;
    }
  } catch {
    // Non-JSON error body: keep the status-based message.
  }

  return new AdminApiError(message, response.status);
}

/** GETs an admin endpoint and unwraps `{ data }`. */
async function getAdmin<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(endpoint), {
    signal,
    headers: { Accept: "application/json", ...authHeaders() },
  });

  if (!response.ok) throw await toAdminApiError(response);

  const body = (await response.json()) as { data: T };
  return body.data;
}

/**
 * Exchanges credentials for a token and stores it.
 *
 * The API answers a wrong password and an unknown email identically, so nothing
 * here can be used to discover which accounts exist.
 */
export async function login(email: string, password: string): Promise<AdminUser> {
  const response = await fetch(apiUrl("/api/auth/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) throw await toAdminApiError(response);

  const body = (await response.json()) as { data: { token: string; user: AdminUser } };
  writeAdminToken(body.data.token);

  return body.data.user;
}

/**
 * The signed-in account, or null when there is no token or it no longer works.
 *
 * The role comes from the database on every call, so demoting an account takes
 * effect on the next load even though the old token is still signed correctly.
 */
export async function fetchMe(signal?: AbortSignal): Promise<AdminUser | null> {
  if (readAdminToken() === null) return null;

  const response = await fetch(apiUrl("/api/auth/me"), {
    signal,
    headers: { Accept: "application/json", ...authHeaders() },
  });

  if (response.status === 401) {
    // Expired, revoked, or the account is gone. Drop it so the login form shows.
    clearAdminToken();
    return null;
  }

  if (!response.ok) throw await toAdminApiError(response);

  const body = (await response.json()) as { data: AdminUser };
  return body.data;
}

export function fetchAdminChannels(signal?: AbortSignal): Promise<AdminChannel[]> {
  return getAdmin<AdminChannel[]>("/api/admin/channels", signal);
}

export function fetchAdminStats(signal?: AbortSignal): Promise<AdminStats> {
  return getAdmin<AdminStats>("/api/admin/stats", signal);
}

/**
 * Pauses or resumes one channel and returns its refreshed row.
 *
 * Pausing only stops future ingestion: the channel's queued messages, its
 * extracted jobs and its statistics are all left in place.
 */
export async function setChannelStatus(
  id: string,
  status: ChannelStatus,
  signal?: AbortSignal,
): Promise<AdminChannel> {
  const response = await fetch(apiUrl(`/api/admin/channels/${encodeURIComponent(id)}`), {
    method: "PATCH",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...authHeaders(),
    },
    body: JSON.stringify({ status }),
  });

  if (!response.ok) throw await toAdminApiError(response);

  const body = (await response.json()) as { data: AdminChannel };
  return body.data;
}
