import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

import { AuthCard } from "@/components/auth-card";
import { CLERK_ENABLED, safeRedirectPath } from "@/lib/clerk";
import { EMBEDDED_CLERK_APPEARANCE } from "@/lib/clerk-appearance";
import { enterAsGuest } from "@/lib/guest-actions";

export const metadata: Metadata = {
  title: "Login",
  description: "Sign in to see jobs and internships matched to your profile.",
};

/**
 * The login screen. Reached from the Login button on `/welcome`, and directly from
 * `proxy.ts` whenever a signed-out visitor follows a link into a gated page — in
 * which case `redirect_url` carries where they were going.
 *
 * An optional catch-all segment is what Clerk requires for a self-hosted page:
 * the flow navigates into sub-paths of its own (`/sign-in/factor-one`,
 * `/sign-in/sso-callback`) and every one of them has to resolve here. Those
 * sub-paths are also why `proxy.ts` never redirects a signed-in request away from
 * `/sign-in` — the session becomes live part-way through, and bouncing it would
 * break OAuth and multi-factor sign-in.
 *
 * The widget is used as-is rather than rebuilt against Clerk's hooks: it already
 * carries the password rules, "remember me", the reset-password flow, the Google
 * button, the verification codes, the error states and the "create an account"
 * link that the reference design shows — and hand-rolling that form would be a
 * second user authentication system in all but name. `AuthCard` supplies the mark,
 * the heading and the Job Seeker | Admin tabs around it, and
 * `EMBEDDED_CLERK_APPEARANCE` strips the widget's own card and heading so there is
 * one card with one title rather than two of each.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = (await searchParams).redirect_url;
  const nextPath = safeRedirectPath(Array.isArray(raw) ? raw[0] : raw);

  return (
    <AuthCard title="Welcome back!" subtitle="Login to continue your job search" tab="seeker">
      {CLERK_ENABLED ? (
        /* `fallbackRedirectUrl` rather than `forceRedirectUrl`: a redirect
           configured in the Clerk dashboard should still win. Falls back to the
           feed when the visitor came here directly. */
        <SignIn appearance={EMBEDDED_CLERK_APPEARANCE} fallbackRedirectUrl={nextPath ?? "/"} />
      ) : (
        <GuestDoor nextPath={nextPath} />
      )}
    </AuthCard>
  );
}

/**
 * What this page offers a checkout with no Clerk keys.
 *
 * There is no sign-in form to draw — Clerk owns every account — but the front door
 * still has to open, otherwise the whole app is unreachable in development. This
 * grants nothing beyond what an anonymous visitor could already read; see
 * `GUEST_COOKIE`. A production build never renders it, because `lib/clerk.ts`
 * refuses to build without the publishable key.
 */
function GuestDoor({ nextPath }: { nextPath: string | null }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="rounded-md border border-border bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
        User sign-in is not configured in this checkout — no Clerk keys are set, so
        there are no accounts to sign in to. You can still browse the public job
        feed.
      </p>

      <form action={enterAsGuest}>
        <input type="hidden" name="next" value={nextPath ?? "/"} />
        <button
          type="submit"
          className="inline-flex min-h-11 w-full items-center justify-center rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
        >
          Continue without signing in
        </button>
      </form>
    </div>
  );
}
