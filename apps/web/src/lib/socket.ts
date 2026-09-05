"use client";

import { useEffect, useRef } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL, type PublicJob } from "./api";

/**
 * Where the realtime connection goes.
 *
 * `NEXT_PUBLIC_SOCKET_URL` only needs setting when Socket.IO is served from a
 * different origin than the REST API; it is the same Express server here, so the
 * API origin is the default. No localhost fallback of its own — `API_BASE_URL` is
 * already validated in `lib/api.ts`, which fails the production build when it is
 * unset rather than letting a bad origin reach the browser.
 */
export const SOCKET_URL = (process.env.NEXT_PUBLIC_SOCKET_URL?.trim() || API_BASE_URL).replace(
  /\/+$/,
  "",
);

let globalSocket: Socket | null = null;

/**
 * Returns a shared Socket.IO client instance.
 */
export function getSocket(): Socket {
  if (!globalSocket) {
    globalSocket = io(SOCKET_URL, {
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      transports: ["websocket", "polling"],
    });
  }
  return globalSocket;
}

/**
 * The realtime channel a list subscribes to.
 *
 * `jobs` carries Telegram and every other normal source; `global-internships`
 * carries the GitHub-backed feed. They are separate channels on the server for a
 * reason: a `/jobs` list prepends whatever arrives, so a Global Internship sent on
 * the `job:*` events appeared in a feed whose own query excludes that source.
 * Subscribing to the wrong channel is the one way to reintroduce that, so a list
 * names its feed and hears nothing else.
 */
export type JobFeed = "jobs" | "global-internships";

const EVENT_NAMES: Record<JobFeed, { created: string; updated: string }> = {
  jobs: { created: "job:new", updated: "job:updated" },
  "global-internships": {
    created: "global-internship:new",
    updated: "global-internship:updated",
  },
};

/**
 * Listens for realtime job events on one feed.
 *
 * `onNewJob` fires for a job that did not exist before. `onJobUpdated` fires when a
 * job already on screen changed — in practice, when background apply-link discovery
 * finishes and the card's Apply button should switch from unavailable to live. The
 * two are separate callbacks because the correct response differs: prepend versus
 * replace in place. Handling an update as a new job would duplicate the card.
 *
 * `onJobUpdated` is optional, so an existing caller that only cares about arrivals
 * needs no change. `feed` defaults to `jobs`, which is what every existing caller
 * wants.
 */
export function useJobSocket(
  onNewJob: (job: PublicJob) => void,
  onJobUpdated?: (job: PublicJob) => void,
  feed: JobFeed = "jobs",
) {
  /* Kept in a ref so a caller passing an inline arrow does not tear the socket
     listener down and rebuild it on every render. `onNewJob` is already in the
     dependency list below for backward compatibility; this keeps the optional
     second callback from adding another reason to resubscribe. */
  const updatedRef = useRef(onJobUpdated);
  updatedRef.current = onJobUpdated;

  useEffect(() => {
    const socket = getSocket();
    const events = EVENT_NAMES[feed];

    const handleJobNew = (job: PublicJob) => {
      if (job && typeof job === "object" && job.id) {
        onNewJob(job);
      }
    };

    const handleJobUpdated = (job: PublicJob) => {
      if (job && typeof job === "object" && job.id) {
        updatedRef.current?.(job);
      }
    };

    socket.on(events.created, handleJobNew);
    socket.on(events.updated, handleJobUpdated);

    return () => {
      socket.off(events.created, handleJobNew);
      socket.off(events.updated, handleJobUpdated);
    };
  }, [onNewJob, feed]);
}
