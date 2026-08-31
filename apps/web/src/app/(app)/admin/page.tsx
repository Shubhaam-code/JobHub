"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ShieldAlert } from "lucide-react";

import { AdminDashboard } from "@/components/admin-dashboard";
import { AdminLogin } from "@/components/admin-login";
import { clearAdminToken, fetchMe, type AdminUser } from "@/lib/admin-api";

/**
 * Admin dashboard route.
 *
 * The gating here is convenience, not security: it decides which of three
 * screens to draw, and the real check is the API's, which answers 401 without a
 * token and 403 for a non-ADMIN account no matter what this page renders. A
 * normal user who types /admin gets the "Admin access required" panel, and if
 * they called the endpoints directly they would still be refused.
 *
 * Linked from the site header, which is safe precisely because of the above: the
 * link leads to a sign-in form, not to anything an anonymous visitor can read.
 */
type Gate = "checking" | "anonymous" | "forbidden" | "admin" | "error";

export default function AdminPage() {
  const [gate, setGate] = useState<Gate>("checking");
  const [user, setUser] = useState<AdminUser | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const check = useCallback(async (signal: AbortSignal) => {
    try {
      const me = await fetchMe(signal);
      if (signal.aborted) return;

      // No token, or one the API no longer accepts (fetchMe clears it).
      if (me === null) {
        setUser(null);
        setGate("anonymous");
        return;
      }

      setUser(me);
      setGate(me.role === "ADMIN" ? "admin" : "forbidden");
    } catch (caught: unknown) {
      if (signal.aborted) return;

      setGate("error");
      setErrorMsg(
        caught instanceof Error
          ? caught.message
          : "Unable to reach the API. Check that it is running and try again.",
      );
    }
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // `check` only sets state after awaiting /api/auth/me. The rule cannot see
    // through the await, so it reports the call itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check(controller.signal);

    return () => controller.abort();
  }, [check]);

  const handleSignedIn = (signedIn: AdminUser) => {
    setUser(signedIn);
    setGate(signedIn.role === "ADMIN" ? "admin" : "forbidden");
  };

  const handleSignedOut = () => {
    setUser(null);
    setGate("anonymous");
  };

  return (
    <main id="main">
      <section className="mx-auto w-full max-w-6xl px-4 pt-12 pb-16 sm:px-6 sm:pt-16 sm:pb-20 lg:px-8">
        {gate === "checking" ? (
          <>
            <span className="sr-only" role="status">
              Checking your access
            </span>
            <div className="mx-auto h-64 max-w-sm animate-pulse rounded-lg border border-border bg-surface shadow-e1" />
          </>
        ) : gate === "error" ? (
          <div className="mx-auto max-w-md rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center">
            <span
              aria-hidden="true"
              className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
            >
              <AlertCircle className="size-6" />
            </span>
            <h1 className="mt-4 font-heading text-base font-semibold text-foreground">
              Unable to check your access
            </h1>
            <p className="mx-auto mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {errorMsg}
            </p>
          </div>
        ) : gate === "anonymous" ? (
          <AdminLogin onSignedIn={handleSignedIn} />
        ) : gate === "forbidden" ? (
          <div className="mx-auto max-w-md rounded-lg border border-border bg-surface px-6 py-10 text-center shadow-e1">
            <span
              aria-hidden="true"
              className="mx-auto grid size-12 place-items-center rounded-full border border-border bg-muted text-muted-foreground"
            >
              <ShieldAlert className="size-6" />
            </span>
            <h1 className="mt-4 font-heading text-lg font-semibold tracking-heading text-foreground">
              Admin access required
            </h1>
            <p className="mx-auto mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {user
                ? `${user.email} is signed in as ${user.role} and cannot view this page.`
                : "This account cannot view this page."}
            </p>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              <Link
                href="/"
                className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
              >
                Back to opportunities
              </Link>
              <button
                type="button"
                onClick={() => {
                  clearAdminToken();
                  handleSignedOut();
                }}
                className="inline-flex min-h-11 items-center rounded-md border border-border bg-surface px-4 text-sm font-medium text-muted-foreground transition-[background-color,border-color,color] duration-150 hover:border-border-strong hover:bg-muted hover:text-foreground pointer-fine:min-h-10"
              >
                Sign in as someone else
              </button>
            </div>
          </div>
        ) : (
          user && <AdminDashboard user={user} onSignedOut={handleSignedOut} />
        )}
      </section>
    </main>
  );
}
