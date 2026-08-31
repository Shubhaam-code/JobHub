"use client";

import { SignOutButton, UserButton, useAuth } from "@clerk/nextjs";
import { LogOut } from "lucide-react";

/**
 * The signed-in half of the site header.
 *
 * Kept in its own file because the header is a client component and Clerk's
 * `<Show>` is not: the `Show` exported from `@clerk/nextjs` is the server one
 * (`<SignedIn>` and `<SignedOut>` were removed in Clerk Core 3), so a client
 * component has to ask `useAuth()` instead. That hook needs a `ClerkProvider`
 * above it, which is why the header renders these only when `CLERK_ENABLED` — a
 * build-time constant, so the branch never changes between renders and the hook
 * is never called without a provider.
 *
 * Sign-out has no destination of its own here: `afterSignOutUrl` on the provider
 * sends it to the landing page.
 */

/** Clerk's avatar menu — account settings and sign out. Desktop header. */
export function ClerkUserButton() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || !isSignedIn) return null;

  return (
    /* The grid box holds the row's height while Clerk mounts its own button, so
       the actions cluster does not jump once the avatar appears. */
    <span className="ml-0.5 hidden size-11 place-items-center md:grid pointer-fine:size-10">
      <UserButton />
    </span>
  );
}

/**
 * Sign out from the mobile menu. The avatar menu is a poor fit at that width, so
 * this is a plain row styled like its siblings in the same list.
 */
export function ClerkSignOutRow({ onNavigate }: { onNavigate: () => void }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded || !isSignedIn) return null;

  return (
    <li>
      <SignOutButton>
        <button
          type="button"
          onClick={onNavigate}
          className="flex min-h-12 w-full items-center gap-2 rounded-md px-3 text-base font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </button>
      </SignOutButton>
    </li>
  );
}
