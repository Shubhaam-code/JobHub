"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, LogOut, Pause, Play, RefreshCw } from "lucide-react";

import {
  AdminApiError,
  clearAdminToken,
  fetchAdminChannels,
  fetchAdminStats,
  setChannelStatus,
  type AdminChannel,
  type AdminStats,
  type AdminUser,
} from "@/lib/admin-api";

interface AdminDashboardProps {
  user: AdminUser;
  /** Called after signing out, so the page can fall back to the login form. */
  onSignedOut: () => void;
}

type LoadState = "loading" | "ready" | "error";

/** "2026-08-31, 14:05" in the viewer's locale, or an em dash when never. */
function formatMoment(value: string | null): string {
  if (value === null) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-e1">
      <p className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
        {label}
      </p>
      <p className="mt-1.5 text-2xl font-semibold text-foreground tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-subtle-foreground">{hint}</p>}
    </div>
  );
}

function StatusPill({ status }: { status: AdminChannel["status"] }) {
  const active = status === "active";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] font-semibold tracking-label uppercase ${
        active
          ? "border border-accent/30 bg-accent/10 text-accent-strong"
          : "border border-border bg-muted text-muted-foreground"
      }`}
    >
      {active ? (
        <CheckCircle2 className="size-3" aria-hidden="true" />
      ) : (
        <Pause className="size-3" aria-hidden="true" />
      )}
      {active ? "Active" : "Paused"}
    </span>
  );
}

/**
 * Channel monitoring and pause/resume.
 *
 * Everything shown here is read from the API, which derives it from the channel
 * registry, TELEGRAM_CHANNELS and stored ingestion data — no list is hardcoded.
 */
export function AdminDashboard({ user, onSignedOut }: AdminDashboardProps) {
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  /** Id of the channel whose status is being written, if any. */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const [nextChannels, nextStats] = await Promise.all([
          fetchAdminChannels(signal),
          fetchAdminStats(signal),
        ]);
        if (signal.aborted) return;

        setChannels(nextChannels);
        setStats(nextStats);
        setState("ready");
      } catch (caught: unknown) {
        if (signal.aborted) return;

        // The token stopped being an admin token mid-session (expired, or the
        // account was demoted). Sign out rather than showing an error forever.
        if (caught instanceof AdminApiError && (caught.status === 401 || caught.status === 403)) {
          clearAdminToken();
          onSignedOut();
          return;
        }

        setState("error");
        setErrorMsg(caught instanceof Error ? caught.message : "An unexpected error occurred.");
      }
    },
    [onSignedOut],
  );

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // `load` only sets state after awaiting the API, which is the "subscribe to
    // an external system" shape the rule allows — but it cannot see through the
    // await, so it reports the call itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(controller.signal);

    return () => controller.abort();
  }, [load, refreshKey]);

  const handleSignOut = () => {
    clearAdminToken();
    onSignedOut();
  };

  /** Flips one channel, then reloads so the derived counters stay truthful. */
  const handleToggle = async (channel: AdminChannel) => {
    if (channel.id === null || pendingId !== null) return;

    const next = channel.status === "active" ? "paused" : "active";

    setPendingId(channel.id);
    setActionError(null);

    try {
      const updated = await setChannelStatus(channel.id, next);
      setChannels((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      // Totals in the strip include active/paused counts, so refresh them too.
      setRefreshKey((key) => key + 1);
    } catch (caught: unknown) {
      setActionError(
        caught instanceof AdminApiError
          ? `Could not ${next === "paused" ? "pause" : "enable"} @${channel.username}: ${caught.message}`
          : `Could not ${next === "paused" ? "pause" : "enable"} @${channel.username}.`,
      );
    } finally {
      setPendingId(null);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-heading text-foreground sm:text-[2rem]">
            Telegram channels
          </h1>
          <p className="mt-1 text-sm text-subtle-foreground">
            Signed in as <span className="font-medium text-foreground">{user.email}</span> ·{" "}
            {user.role}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setRefreshKey((key) => key + 1)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Refresh
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
          >
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </div>

      {state === "error" ? (
        <div className="mt-8 rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
          >
            <AlertCircle className="size-6" />
          </span>
          <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
            Unable to load the dashboard
          </h2>
          <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
            {errorMsg}
          </p>
          <button
            type="button"
            onClick={() => {
              setState("loading");
              setRefreshKey((key) => key + 1);
            }}
            className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      ) : state === "loading" ? (
        <div className="mt-8">
          <span className="sr-only" role="status">
            Loading channels
          </span>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="h-[86px] animate-pulse rounded-lg border border-border bg-surface shadow-e1"
              />
            ))}
          </div>
          <div className="mt-6 h-64 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
        </div>
      ) : (
        <>
          {stats && (
            <div className="mt-7 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                label="Channels"
                value={stats.channels.total.toLocaleString()}
                hint={`${stats.channels.active} active · ${stats.channels.paused} paused`}
              />
              <StatCard
                label="Messages received"
                value={stats.messages.received.toLocaleString()}
                hint={`${stats.messages.pending} pending · ${stats.messages.failed} failed`}
              />
              <StatCard
                label="Jobs extracted"
                value={stats.jobs.extracted.toLocaleString()}
                hint={`${stats.messages.processed.toLocaleString()} messages processed`}
              />
              <StatCard
                label="Jobs in database"
                value={stats.jobs.inDatabase.toLocaleString()}
                hint={`Last message ${formatMoment(stats.lastMessageAt)}`}
              />
            </div>
          )}

          {stats && !stats.ingestion.telegramConfigured && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Telegram is not configured on the API, so no new messages are being received. Existing
              channels and jobs are unaffected.
            </p>
          )}

          {stats && stats.ingestion.telegramConfigured && !stats.ingestion.queueWorkerEnabled && (
            <p className="mt-4 flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              The queue worker is disabled, so received messages are being stored but not yet turned
              into jobs.
            </p>
          )}

          {actionError && (
            <p
              role="alert"
              className="mt-4 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {actionError}
            </p>
          )}

          <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface shadow-e1">
            <table className="w-full min-w-[860px] border-collapse text-sm">
              <caption className="sr-only">
                Telegram channels with ingestion statistics and a pause control
              </caption>
              <thead>
                <tr className="border-b border-border text-left">
                  {[
                    "Channel",
                    "Status",
                    "Messages",
                    "Jobs",
                    "Processed",
                    "Failed",
                    "Last message",
                    "Last sync",
                    "",
                  ].map((heading, index) => (
                    <th
                      key={heading || `actions-${index}`}
                      scope="col"
                      className={`px-4 py-3 text-[11px] font-semibold tracking-label text-subtle-foreground uppercase ${
                        index >= 2 && index <= 5 ? "text-right" : ""
                      }`}
                    >
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {channels.length === 0 ? (
                  <tr>
                    <td
                      colSpan={9}
                      className="px-4 py-10 text-center text-sm text-subtle-foreground"
                    >
                      No channels are configured yet. Add usernames to TELEGRAM_CHANNELS in the API
                      environment and restart it.
                    </td>
                  </tr>
                ) : (
                  channels.map((channel) => {
                    const busy = pendingId === channel.id;
                    const paused = channel.status === "paused";

                    return (
                      <tr
                        key={channel.username}
                        className="border-b border-border/70 last:border-b-0"
                      >
                        <td className="px-4 py-3">
                          <span className="block font-medium text-foreground">{channel.name}</span>
                          <span className="block text-xs text-subtle-foreground">
                            @{channel.username}
                            {!channel.configured && " · not in TELEGRAM_CHANNELS"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill status={channel.status} />
                        </td>
                        <td className="px-4 py-3 text-right text-foreground tabular-nums">
                          {channel.messagesReceived.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right text-foreground tabular-nums">
                          {channel.jobsInDatabase.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right text-muted-foreground tabular-nums">
                          {channel.jobsProcessed.toLocaleString()}
                        </td>
                        <td
                          className={`px-4 py-3 text-right tabular-nums ${
                            channel.messagesFailed > 0
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                        >
                          {channel.messagesFailed.toLocaleString()}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          {formatMoment(channel.lastMessageAt)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                          {formatMoment(channel.lastSyncAt)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          {channel.id === null ? (
                            <span className="text-xs text-subtle-foreground">
                              No registry entry
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void handleToggle(channel)}
                              disabled={pendingId !== null}
                              aria-label={`${paused ? "Enable" : "Pause"} @${channel.username}`}
                              className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-[13px] font-semibold text-foreground transition-[background-color,border-color,box-shadow] duration-150 hover:border-border-strong hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                            >
                              {busy ? (
                                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                              ) : paused ? (
                                <Play className="size-3.5" aria-hidden="true" />
                              ) : (
                                <Pause className="size-3.5" aria-hidden="true" />
                              )}
                              {paused ? "Enable" : "Pause"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-4 max-w-3xl text-xs leading-relaxed text-subtle-foreground">
            Message counters are derived from the ingestion queue, so they cover the period since
            queued ingestion was enabled. <span className="font-medium">Jobs</span> is a live count
            from the jobs collection and includes everything ever extracted — an older channel can
            therefore show more jobs than messages. Pausing a channel stops new messages being taken
            from it; its existing jobs and queued messages are kept, and enabling it resumes from
            where it left off.
          </p>
        </>
      )}
    </>
  );
}
