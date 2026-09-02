"use client";

import { AlertCircle, Loader2, RefreshCw } from "lucide-react";

/**
 * The panel shown when a request the screen depends on failed.
 *
 * Always carries the server's own message and a way to try again — a failed load
 * should be recoverable in place rather than needing a page reload.
 */
export function ErrorPanel({
  title,
  message,
  onRetry,
}: {
  title: string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-6 py-10 text-center">
      <span
        aria-hidden="true"
        className="mx-auto grid size-12 place-items-center rounded-full border border-destructive/20 bg-destructive/10 text-destructive"
      >
        <AlertCircle className="size-6" />
      </span>
      <h2 className="mt-4 font-heading text-base font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
        {message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex min-h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10"
      >
        <RefreshCw className="size-4" aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}

/** Placeholder blocks while a card's data is in flight. */
export function CardSkeleton({ className = "h-64" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-lg border border-border bg-surface shadow-e1 ${className}`}
    />
  );
}

/**
 * One line of "this is working on it", shown next to the skeletons rather than
 * over them.
 *
 * The skeletons alone say the shape of what is coming but not that anything is
 * happening, which on a slow fetch reads as a stalled page. A named wait —
 * "Looking for your recommended jobs…" — is the part a reader can act on, so it
 * says what is being waited for rather than a bare "Loading".
 *
 * `role="status"` and no `aria-live` of its own: the role carries `polite`
 * already, and this replaces the screens' previous `sr-only` status lines, so the
 * announcement is unchanged and now visible too. Deliberately not a spinner over
 * a dimmed page or a modal — it costs no layout and disappears the moment the
 * caller's state leaves "loading".
 */
export function InlineLoading({ label, className = "" }: { label: string; className?: string }) {
  return (
    <p
      role="status"
      className={`inline-flex items-center gap-2 text-xs font-medium text-muted-foreground sm:text-sm ${className}`}
    >
      <Loader2
        className="size-3.5 shrink-0 animate-spin text-primary sm:size-4"
        aria-hidden="true"
      />
      {label}
    </p>
  );
}
