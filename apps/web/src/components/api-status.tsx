"use client";

import { useEffect, useState } from "react";

import { API_BASE_URL, fetchApiHealth, type ApiHealth } from "@/lib/api";

type Status =
  | { kind: "loading" }
  | { kind: "online"; health: ApiHealth }
  | { kind: "offline"; message: string };

const DOT_STYLES: Record<Status["kind"], string> = {
  loading: "bg-neutral-400 animate-pulse",
  online: "bg-emerald-500",
  offline: "bg-amber-500",
};

/**
 * Pings the API from the browser so the production build stays independent of
 * whether the API happens to be running at build time.
 */
export function ApiStatus() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    fetchApiHealth(controller.signal)
      .then((health) => setStatus({ kind: "online", health }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setStatus({
          kind: "offline",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      });

    return () => controller.abort();
  }, []);

  return (
    <section
      aria-live="polite"
      className="rounded-xl border border-black/10 bg-black/[0.02] p-5 dark:border-white/15 dark:bg-white/[0.03]"
    >
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className={`size-2.5 shrink-0 rounded-full ${DOT_STYLES[status.kind]}`}
        />
        <h2 className="text-sm font-semibold tracking-tight">
          {status.kind === "loading" && "Checking API…"}
          {status.kind === "online" && "API reachable"}
          {status.kind === "offline" && "API unreachable"}
        </h2>
      </div>

      <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-neutral-500 dark:text-neutral-400">Base URL</dt>
        <dd className="font-mono text-xs break-all sm:text-sm">{API_BASE_URL}</dd>

        {status.kind === "online" && (
          <>
            <dt className="text-neutral-500 dark:text-neutral-400">Environment</dt>
            <dd>{status.health.environment}</dd>

            <dt className="text-neutral-500 dark:text-neutral-400">Database</dt>
            <dd>
              {status.health.database.status}
              {!status.health.database.connected && (
                <span className="text-neutral-500 dark:text-neutral-400">
                  {" — expected until MongoDB is running"}
                </span>
              )}
            </dd>
          </>
        )}

        {status.kind === "offline" && (
          <>
            <dt className="text-neutral-500 dark:text-neutral-400">Reason</dt>
            <dd>{status.message}</dd>

            <dt className="text-neutral-500 dark:text-neutral-400">Fix</dt>
            <dd>
              Start the API with <code className="font-mono text-xs">npm run dev:api</code>
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
