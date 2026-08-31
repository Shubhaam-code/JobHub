"use client";

import { useEffect } from "react";
import { io, type Socket } from "socket.io-client";
import { API_BASE_URL, type PublicJob } from "./api";

export const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE_URL || "http://localhost:4000";

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
