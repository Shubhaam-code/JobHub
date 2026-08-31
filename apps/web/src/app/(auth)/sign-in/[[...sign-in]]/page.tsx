import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { ArrowLeft } from "lucide-react";

import { CLERK_ENABLED, WELCOME_PATH, safeRedirectPath } from "@/lib/clerk";

export const metadata: Metadata = {
  title: "Sign in to your account — JobFeed",
};

/**
 * Clerk's own sign-in widget, mounted on our own route.
 *
 * An optional catch-all segment is what Clerk requires for a self-hosted page:
 * the flow navigates into sub-paths of its own (`/sign-in/factor-one`,
 * `/sign-in/sso-callback`) and every one of them has to resolve here. Those
 * sub-paths are also why `proxy.ts` never redirects a signed-in request away from
 * `/sign-in` — the session becomes live part-way through, and bouncing it would
 * break OAuth and multi-factor sign-in.
 *
 * The widget is used as-is rather than rebuilt against Clerk's hooks: it already
 * carries the password rules, the verification codes, the error states and the
 * "create an account" link, and hand-rolling a form would be a second user
 * authentication system in all but name.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /* Nothing here can work without a Clerk instance, and this route is only
     reachable by typing it in that state. `/welcome` explains what is missing,
     and it never redirects back, so this cannot loop. */
  if (!CLERK_ENABLED) redirect(WELCOME_PATH);

  const raw = (await searchParams).redirect_url;
  const nextPath = safeRedirectPath(Array.isArray(raw) ? raw[0] : raw);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      {/* `fallbackRedirectUrl` rather than `forceRedirectUrl`: a redirect
          configured in the Clerk dashboard should still win. Falls back to the
          feed when the visitor came here directly. */}
      <SignIn fallbackRedirectUrl={nextPath ?? "/"} />

      <Link
        href={WELCOME_PATH}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to sign-in options
      </Link>
    </div>
  );
}
