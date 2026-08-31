/**
 * Whether Clerk user authentication is wired up.
 *
 * Read from `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` only, deliberately. A
 * `NEXT_PUBLIC_` variable is inlined at build time into *both* the server render
 * and the browser bundle, so this flag has the same value on both sides and
 * cannot cause a hydration mismatch. `CLERK_SECRET_KEY` must never be consulted
 * here: Next replaces non-public variables with `undefined` in client bundles,
 * which would flip the flag between server and client and desync the tree.
 *
 * The publishable key is safe to ship — it is public by design and identifies
 * the Clerk instance, nothing more. The secret key is read only in `proxy.ts`,
 * which runs on the server.
 */
const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim();

/* Fail the production build rather than ship an app whose gate silently does
   nothing. The root layout imports this module, so `next build` evaluates it
   while rendering and stops here with a message naming the missing variable.
   Development is left permissive on purpose: the feed, the job detail view and
   the admin dashboard keep working without Clerk keys, so the rest of the
   project stays runnable for anyone who has not set up a Clerk instance. */
if (process.env.NODE_ENV === "production" && !publishableKey) {
  throw new Error(
    "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set. User authentication cannot be " +
      "enforced without it, so this build was stopped instead of producing an " +
      "unauthenticated app. Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY " +
      "(see apps/web/.env.example).",
  );
}

export const CLERK_ENABLED = Boolean(publishableKey);

/* Where the two auth flows live. Kept here so the landing page, the proxy and
   the header all agree on one spelling of each path. */
export const WELCOME_PATH = "/welcome";
export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";

/**
 * Marks a visitor who came through the landing page while Clerk was not
 * configured.
 *
 * This is *not* a second authentication system and proves nothing about who the
 * visitor is — it only records that they chose "Continue as User" on the landing
 * page, so the app can open at the feed instead of bouncing back. It unlocks
 * exactly what an anonymous visitor could already read: the public job feed. The
 * admin dashboard still needs the API's own bearer token and `requireAdmin`, and
 * resume/recommendations still need the profile token, both checked server-side.
 *
 * It exists so the sign-in-first flow is complete for a checkout with no Clerk
 * instance. It persists across browser restarts until the visitor signs out, so
 * the keyless path behaves like the other two. With Clerk configured the real
 * session takes over and this is never read. A production build cannot reach this
 * path at all — `CLERK_ENABLED` is false only when the key is missing, which
 * stops the build above.
 */
export const GUEST_COOKIE = "jia.guest";

/**
 * Reduce an untrusted `redirect_url` to a same-origin path, or `null`.
 *
 * The value arrives in a query string, so anyone can choose it. Without this an
 * attacker could hand out `/welcome?redirect_url=https://evil.example` and have
 * our own sign-in flow send the visitor there afterwards. Only a plain path is
 * accepted: a leading `//` or `/\` is how a browser reads a protocol-relative
 * URL, so both are rejected along with anything carrying a scheme.
 */
export function safeRedirectPath(value: string | null | undefined): string | null {
  if (!value) return null;
  if (!value.startsWith("/")) return null;
  if (value.startsWith("//") || value.startsWith("/\\")) return null;
  return value;
}
