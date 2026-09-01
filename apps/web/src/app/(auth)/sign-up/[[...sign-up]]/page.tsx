import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";

import { AuthCard } from "@/components/auth-card";
import { CLERK_ENABLED, SIGN_IN_PATH, safeRedirectPath } from "@/lib/clerk";
import { EMBEDDED_CLERK_APPEARANCE } from "@/lib/clerk-appearance";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Create an account to save your resume and get matched job recommendations.",
};

/**
 * Clerk's sign-up widget. Same shape as the sign-in page, and the same reasons:
 * an optional catch-all so Clerk's verification sub-paths resolve here, and the
 * stock component so account creation, email verification and password rules stay
 * Clerk's problem rather than becoming a second auth system of ours.
 *
 * No Job Seeker | Admin tabs here, unlike the sign-in screen: admin accounts are
 * created by the operator (`ADMIN_EMAIL` at API startup, or `npm run user:create`),
 * so there is no admin sign-up for a tab to lead to and no amount of self-service
 * signup produces one. Clerk's own footer carries the "Already have an account?"
 * link back to sign-in.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  /* Nothing here can work without a Clerk instance, and this route is only
     reachable by typing it in that state. `/sign-in` explains what is missing and
     never redirects back here, so this cannot loop. */
  if (!CLERK_ENABLED) redirect(SIGN_IN_PATH);

  const raw = (await searchParams).redirect_url;
  const nextPath = safeRedirectPath(Array.isArray(raw) ? raw[0] : raw);

  return (
    <AuthCard title="Create your account" subtitle="Start your job search in minutes">
      <SignUp appearance={EMBEDDED_CLERK_APPEARANCE} fallbackRedirectUrl={nextPath ?? "/"} />
    </AuthCard>
  );
}
