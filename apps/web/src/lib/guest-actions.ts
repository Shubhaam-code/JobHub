"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { CLERK_ENABLED, GUEST_COOKIE, WELCOME_PATH, safeRedirectPath } from "@/lib/clerk";

/**
 * The "Continue as User" door for a checkout with no Clerk instance.
 *
 * With Clerk configured these actions are unreachable: the landing page renders
 * a link to `/sign-in` instead, and both bail out below anyway. They exist so the
 * landing page is a working front door rather than a dead end — see
 * `GUEST_COOKIE` for why this grants nothing.
 */
export async function enterAsGuest(formData: FormData) {
  if (CLERK_ENABLED) redirect(WELCOME_PATH);

  const raw = formData.get("next");
  const next = safeRedirectPath(typeof raw === "string" ? raw : null) ?? "/";

  (await cookies()).set(GUEST_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    /* Persist until the visitor signs out, matching how the Clerk session and the
       admin token behave — closing the browser should not cost you your place.
       A year is effectively "until sign-out"; `leaveAsGuest` is the way back. */
    maxAge: 60 * 60 * 24 * 365,
  });

  redirect(next);
}

/** Clears the marker, which sends the visitor back to the landing page. */
export async function leaveAsGuest() {
  if (CLERK_ENABLED) redirect(WELCOME_PATH);

  (await cookies()).delete(GUEST_COOKIE);
  redirect(WELCOME_PATH);
}
