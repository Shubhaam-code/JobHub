import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import { ArrowLeft } from "lucide-react";

import { CLERK_ENABLED, WELCOME_PATH, safeRedirectPath } from "@/lib/clerk";

export const metadata: Metadata = {
  title: "Create an account — JobFeed",
};

/**
 * Clerk's sign-up widget. Same shape as the sign-in page, and the same reasons:
 * an optional catch-all so Clerk's verification sub-paths resolve here, and the
 * stock component so account creation, email verification and password rules stay
 * Clerk's problem rather than becoming a second auth system of ours.
 *
 * Signing up here creates a normal user and nothing more. Admin accounts come
 * only from the operator (`ADMIN_EMAIL` at API startup, or `npm run user:create`),
 * so no amount of self-service signup produces an admin.
 */
export default async function SignUpPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!CLERK_ENABLED) redirect(WELCOME_PATH);

  const raw = (await searchParams).redirect_url;
  const nextPath = safeRedirectPath(Array.isArray(raw) ? raw[0] : raw);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <SignUp fallbackRedirectUrl={nextPath ?? "/"} />

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
