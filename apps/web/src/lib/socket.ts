"use client";

import { useEffect } from "react";
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
 * React hook to listen for real-time "job:new" Socket.IO events.
 */
export function useJobSocket(onNewJob: (job: PublicJob) => void) {
  useEffect(() => {
    const socket = getSocket();

    const handleJobNew = (job: PublicJob) => {
      if (job && typeof job === "object" && job.id) {
        onNewJob(job);
      }
    };

    socket.on("job:new", handleJobNew);

    return () => {
      socket.off("job:new", handleJobNew);
    };
  }, [onNewJob]);
}
