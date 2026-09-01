"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertCircle, ShieldAlert } from "lucide-react";

import { AdminLogin } from "@/components/admin-login";
import { AdminShell } from "@/components/admin-shell";
import { clearAdminToken, fetchMe, type AdminUser } from "@/lib/admin-api";

/**
 * Decides which of four screens an admin route draws: the loading placeholder,
 * the sign-in card, the "not an admin" panel, or the console with `children` in it.
 *
 * The gating here is convenience, not security. The real check is the API's, which
 * answers 401 without a token and 403 for a non-ADMIN account no matter what this
 * renders — so a normal user who types /admin gets the sign-in card, and calling
 * the endpoints directly would still be refused. That is also why the site header
 * can link here safely: the link leads to a form, not to anything readable.
 *
 * Shared by every admin route so the check, the sign-in card and the shell are
 * defined once rather than repeated per page.
 */
type Gate = "checking" | "anonymous" | "forbidden" | "admin" | "error";

export function AdminGate({ children }: { children: React.ReactNode }) {
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

  if (gate === "admin" && user) {
    return (
      <AdminShell user={user} onSignedOut={handleSignedOut}>
        {children}
      </AdminShell>
    );
  }

  /* Everything below is a single centred panel — the console's sidebar belongs to
     a confirmed admin, so it is deliberately absent until there is one. */
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 sm:px-6 sm:py-16">
      {gate === "checking" ? (
        <>
          <span className="sr-only" role="status">
            Checking your access
          </span>
          <div className="h-96 w-full max-w-[26.5rem] animate-pulse rounded-xl border border-border bg-surface shadow-e1" />
        </>
      ) : gate === "error" ? (
        <div className="w-full max-w-md rounded-xl border border-destructive/25 bg-destructive/5 px-6 py-10 text-center">
          <span
            aria-hidden="true"
            className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
          >
            <AlertCircle className="size-6" />
          </span>
          <h1 className="mt-4 font-heading text-base font-semibold text-foreground">
            Unable to check your access
          </h1>
          <p className="mx-auto mt-1.5 text-sm leading-relaxed text-muted-foreground">{errorMsg}</p>
        </div>
      ) : gate === "forbidden" ? (
        <div className="w-full max-w-md rounded-xl border border-border bg-surface px-6 py-10 text-center shadow-e2">
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
              Back to jobs
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
        <AdminLogin onSignedIn={handleSignedIn} />
      )}
    </div>
  );
}
