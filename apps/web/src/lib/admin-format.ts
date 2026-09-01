/**
 * Shared formatting for the admin console.
 *
 * Locale-dependent on purpose — an operator reading their own dashboard wants
 * their own clock. Every caller renders it only after data has loaded in the
 * browser, so the server never emits a differently-formatted copy for hydration to
 * disagree with.
 */

/** "31 Aug 2026, 14:05" in the viewer's locale, or an em dash when never. */
export function formatMoment(value: string | null): string {
  if (value === null) return "—";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
