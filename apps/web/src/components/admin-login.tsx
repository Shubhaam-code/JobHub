"use client";

import { useState } from "react";
import { AlertCircle, Loader2, LogIn, ShieldCheck } from "lucide-react";

import { AdminApiError, login, type AdminUser } from "@/lib/admin-api";

interface AdminLoginProps {
  /** Called with the signed-in account once the API accepts the credentials. */
  onSignedIn: (user: AdminUser) => void;
}

/**
 * Sign-in form for the admin dashboard.
 *
 * There is no signup: accounts are created by the operator (ADMIN_EMAIL at
 * startup, or `npm run user:create`). A wrong password and an unknown email give
 * the same message because the API answers them identically.
 */
export function AdminLogin({ onSignedIn }: AdminLoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      const user = await login(email.trim(), password);
      onSignedIn(user);
    } catch (caught: unknown) {
      setError(
        caught instanceof AdminApiError
          ? caught.message
          : "Unable to reach the API. Check that it is running and try again.",
      );
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      <div className="rounded-lg border border-border bg-surface p-6 shadow-e1 sm:p-7">
        <span
          aria-hidden="true"
          className="grid size-11 place-items-center rounded-md border border-border bg-muted text-muted-foreground"
        >
          <ShieldCheck className="size-5" />
        </span>

        <h1 className="mt-4 font-heading text-xl font-semibold tracking-heading text-foreground">
          Admin sign in
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-subtle-foreground">
          This area is restricted to administrator accounts.
        </p>

        <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-email" className="text-sm font-medium text-foreground">
              Email
            </label>
            <input
              id="admin-email"
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors duration-150 outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 pointer-fine:min-h-10"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-password" className="text-sm font-medium text-foreground">
              Password
            </label>
            <input
              id="admin-password"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="min-h-11 rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors duration-150 outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 pointer-fine:min-h-10"
            />
          </div>

          {error && (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-sm leading-relaxed text-destructive"
            >
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 pointer-fine:min-h-10"
          >
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogIn className="size-4" aria-hidden="true" />
            )}
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
