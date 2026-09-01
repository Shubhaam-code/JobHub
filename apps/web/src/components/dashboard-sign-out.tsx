"use client";

import { LogOut } from "lucide-react";

import { ClerkSignOutInline } from "@/components/clerk-account-control";
import { CLERK_ENABLED } from "@/lib/clerk";
import { leaveAsGuest } from "@/lib/guest-actions";

const ROW_CLASS =
  "flex min-h-11 w-full items-center gap-2.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-destructive/5 hover:text-destructive pointer-fine:min-h-10";

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
        <LogOut className="size-4 shrink-0" aria-hidden="true" />
        Logout
      </button>
    </form>
  );
}
