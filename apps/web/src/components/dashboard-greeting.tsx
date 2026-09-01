"use client";

import { ClerkFirstName } from "@/components/clerk-account-control";
import { CLERK_ENABLED } from "@/lib/clerk";

/**
 * "Hi, Ada 👋" — the dashboard's own heading.
 *
 * The name comes from the signed-in Clerk account and nowhere else. Without Clerk
 * configured there is no account to read a name from, so the greeting simply has
 * no name in it. `CLERK_ENABLED` is a build-time constant, so this branch is fixed
 * and the hook inside `ClerkFirstName` is never called without a provider above.
 */
export function DashboardGreeting({ subtitle }: { subtitle: string }) {
  return (
    <header>
      <h1 className="font-heading text-2xl leading-tight font-semibold tracking-display text-foreground sm:text-3xl">
        Hi{CLERK_ENABLED && <ClerkFirstName />}{" "}
        <span aria-hidden="true">👋</span>
      </h1>
      <p className="mt-2 text-[15px] leading-relaxed text-muted-foreground">{subtitle}</p>
    </header>
  );
}
