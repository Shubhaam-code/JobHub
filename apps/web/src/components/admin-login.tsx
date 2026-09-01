"use client";

import { useState } from "react";
import { AlertCircle, Loader2 } from "lucide-react";

import { AuthCard } from "@/components/auth-card";
import { AdminApiError, login, type AdminUser } from "@/lib/admin-api";

interface AdminLoginProps {
  /** Called with the signed-in account once the API accepts the credentials. */
  onSignedIn: (user: AdminUser) => void;
}

const FIELD_CLASS =
  "min-h-11 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground transition-colors duration-150 outline-none placeholder:text-subtle-foreground focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 pointer-fine:min-h-10";

/**
 * Sign-in form for the admin console.
 *
 * Drawn in the same `AuthCard` as the user sign-in screen, with the Admin tab
 * active — the reference design's two tabs, and they are two genuinely separate
 * systems: this form exchanges credentials for the API's own bearer token via
 * `POST /api/auth/login`, and every `/api/admin/*` request is then checked by the
 * server's `requireAdmin`. A Clerk user session confers nothing here.
 *
 * There is no signup and no "forgot password", unlike the seeker tab: accounts are
 * created by the operator (ADMIN_EMAIL at API startup, or `npm run user:create`)
 * and the API has no reset flow, so offering either would be a dead button. A wrong
 * password and an unknown email give the same message because the API answers them
 * identically — nothing here can be used to discover which accounts exist.
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
    <AuthCard
      title="Welcome back!"
      subtitle="Login to the admin console"
      tab="admin"
      footer="Admin accounts are created by the operator, so there is no signup here."
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
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
            placeholder="admin@example.com"
            className={FIELD_CLASS}
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
            placeholder="••••••••"
            className={FIELD_CLASS}
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
          className="mt-1 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60"
        >
          {submitting && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {submitting ? "Logging in…" : "Login"}
        </button>
      </form>
    </AuthCard>
  );
}
