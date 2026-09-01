"use client";

import { useCallback, useEffect, useState } from "react";

import { errorText, fetchProfile, type CandidateProfile } from "@/lib/profile";

/**
 * `empty` is not a failure: the API mints the profile token on the first resume
 * upload, so "no profile yet" is the ordinary starting state and the screens ask
 * for a resume rather than showing an error.
 */
export type ProfileStatus = "loading" | "empty" | "ready" | "error";

export interface UseCandidateProfile {
  status: ProfileStatus;
  profile: CandidateProfile | null;
  error: string;
  /** Refetch from the API — what a "Try again" button calls. */
  reload: () => void;
  /** Take the profile an upload or a save just returned, without a refetch. */
  adopt: (next: CandidateProfile) => void;
}

/**
 * Loads the caller's candidate profile.
 *
 * The dashboard shows the same profile on three screens, so the load lives here
 * once instead of being copied into each page. Nothing is cached between mounts:
 * a resume upload changes the profile, and a stale copy on the next screen would
 * be worse than one more request.
 */
export function useCandidateProfile(): UseCandidateProfile {
  const [status, setStatus] = useState<ProfileStatus>("loading");
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  /* A promise chain rather than an awaited helper, so every state update lands in
     a callback: an update on the synchronous path out of an effect cascades an
     extra render. */
  useEffect(() => {
    let subscribed = true;
    const controller = new AbortController();

    fetchProfile(controller.signal)
      .then((result) => {
        if (!subscribed) return;

        // null covers both "no token stored" and "the stored token no longer
        // resolves" — `fetchProfile` drops a dead one. Either way: no profile.
        if (result === null) {
          setProfile(null);
          setStatus("empty");
          return;
        }

        setProfile(result);
        setStatus("ready");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || !subscribed) return;
        setError(errorText(caught));
        setStatus("error");
      });

    return () => {
      subscribed = false;
      controller.abort();
    };
  }, [reloadKey]);

  const reload = useCallback(() => {
    setStatus("loading");
    setError("");
    setReloadKey((key) => key + 1);
  }, []);

  const adopt = useCallback((next: CandidateProfile) => {
    setProfile(next);
    setStatus("ready");
  }, []);

  return { status, profile, error, reload, adopt };
}
