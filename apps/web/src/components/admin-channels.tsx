"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2, Pause, Play, RefreshCw } from "lucide-react";

import {
  AdminApiError,
  fetchAdminChannels,
  setChannelStatus,
  type AdminChannel,
} from "@/lib/admin-api";
import { formatMoment } from "@/lib/admin-format";

type LoadState = "loading" | "ready" | "error";

function StatusPill({ status }: { status: AdminChannel["status"] }) {
  const active = status === "active";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] font-semibold tracking-label uppercase ${
        active
          ? "border border-primary/30 bg-primary/10 text-primary-strong"
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
 * Channel monitoring and pause/resume — the only writes this console performs.
 *
 * Everything shown here is read from the API, which derives it from the channel
 * registry, TELEGRAM_CHANNELS and stored ingestion data — no list is hardcoded.
 *
 * The sign-out control and the account line live in `AdminShell`, which wraps every
 * admin screen, so this component is only the table.
 */
export function AdminChannels() {
  const [channels, setChannels] = useState<AdminChannel[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  /** Id of the channel whose status is being written, if any. */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const next = await fetchAdminChannels(signal);
      if (signal.aborted) return;

      setChannels(next);
      setState("ready");
    } catch (caught: unknown) {
      if (signal.aborted) return;

      setState("error");
      setErrorMsg(caught instanceof Error ? caught.message : "An unexpected error occurred.");
    }
  }, []);

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

  /** Flips one channel, then reloads so the derived counters stay truthful. */
  const handleToggle = async (channel: AdminChannel) => {
    if (channel.id === null || pendingId !== null) return;

    const next = channel.status === "active" ? "paused" : "active";

    setPendingId(channel.id);
    setActionError(null);

    try {
      const updated = await setChannelStatus(channel.id, next);
      setChannels((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
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
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl leading-tight font-semibold tracking-display text-foreground sm:text-3xl">
            Channels
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">
            The sources listings are ingested from. Pausing one stops new messages being taken from
            it.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setRefreshKey((key) => key + 1)}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Refresh
        </button>
      </div>

      {actionError && (
        <p
          role="alert"
          className="mt-6 flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
        >
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {actionError}
        </p>
      )}

      {state === "error" ? (
        <div className="mt-6 rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
          >
            <AlertCircle className="size-6" />
          </span>
          <h2 className="mt-4 font-heading text-base font-semibold text-foreground">
            Unable to load channels
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
        <div className="mt-6">
          <span className="sr-only" role="status">
            Loading channels
          </span>
          <div className="h-72 animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
        </div>
      ) : (
        <>
          <div className="mt-6 overflow-x-auto rounded-lg border border-border bg-surface shadow-e1">
            <table className="w-full min-w-[54rem] border-collapse text-sm">
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
                    "Failed",
                    "Last message",
                    "Last sync",
                    "",
                  ].map((heading, index) => (
                    <th
                      key={heading || `actions-${index}`}
                      scope="col"
                      className={`px-4 py-3 text-[11px] font-semibold tracking-label text-subtle-foreground uppercase ${
                        index >= 2 && index <= 4 ? "text-right" : ""
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
                    <td colSpan={8} className="px-4 py-10 text-center text-sm text-subtle-foreground">
                      No channels are configured yet. Add usernames to TELEGRAM_CHANNELS in the API
                      environment and restart it.
                    </td>
                  </tr>
                ) : (
                  channels.map((channel) => {
                    const busy = pendingId === channel.id;
                    const paused = channel.status === "paused";

                    return (
                      <tr key={channel.username} className="border-b border-border/70 last:border-b-0">
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
                        <td
                          className={`px-4 py-3 text-right tabular-nums ${
                            channel.messagesFailed > 0 ? "text-destructive" : "text-muted-foreground"
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
                            <span className="text-xs text-subtle-foreground">No registry entry</span>
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
            therefore show more jobs than messages. Pausing a channel keeps its existing jobs and
            queued messages, and enabling it resumes from where it left off.
          </p>
        </>
      )}
    </>
  );
}
