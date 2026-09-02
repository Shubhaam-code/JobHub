"use client";

import { LogOut } from "lucide-react";

import { ClerkSignOutInline } from "@/components/clerk-account-control";
import { CLERK_ENABLED } from "@/lib/clerk";
import { leaveAsGuest } from "@/lib/guest-actions";

const ROW_CLASS =
  "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:bg-destructive/5 hover:text-destructive whitespace-nowrap sm:min-h-11 sm:gap-2.5 sm:px-3 sm:text-sm pointer-fine:min-h-10";

/**
 * The sidebar's Logout row.
 *
 * Two real exits, one per auth path: Clerk ends its session, and the keyless
 * checkout clears the landing-page marker. `CLERK_ENABLED` is a build-time
 * constant, so this branch is fixed and the hook inside `ClerkSignOutInline` is
 * never called without a provider above it.
 */
export function DashboardSignOut() {
  if (CLERK_ENABLED) return <ClerkSignOutInline className={ROW_CLASS} />;

  return (
    <form action={leaveAsGuest}>
      <button type="submit" className={ROW_CLASS}>
        <LogOut className="size-3.5 shrink-0 sm:size-4" aria-hidden="true" />
        Logout
      </button>
    </form>
  );
}
