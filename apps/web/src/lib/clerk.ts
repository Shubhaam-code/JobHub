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

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/* This used to `throw` here, which made `next build` depend on the Clerk keys
   being present in the *build* environment. That is not a safe assumption on a
   host that only guarantees them at runtime (Render injects a service's
   variables into the container; a Docker image or a preview build can be
   produced without them), and it took the whole deploy down with the message
   this file used to print.

   The enforcement moved to the two places that can act on it: `next.config.ts`
   warns once if the build environment has no key, and `proxy.ts` runs per
   request and refuses to serve a production deployment whose keys are missing —
   the same fail-closed guarantee, enforced where the keys actually have to
   exist. Nothing in this module throws, because every static-generation worker
   evaluates it. */

/**
 * Whether to render the Clerk tree.
 *
 * `true` unconditionally in production: a production deployment is required to
 * have Clerk configured — `proxy.ts` refuses to serve one that does not — so the
 * authentication flow is the same whether or not the key happened to be present
 * when the bundle was compiled. This is what lets the key arrive at runtime:
 * `ClerkProvider` is a server component that reads
 * `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` from `process.env` per request and hands it
 * to the browser as a prop, so nothing here needs the value inlined.
 *
 * Development stays keyed off the variable, so the feed, the job detail view and
 * the admin dashboard keep working for a checkout with no Clerk instance.
 *
 * Both inputs are build-time constants that Next inlines identically into the
 * server render and the browser bundle, so the two sides always agree and this
 * cannot cause a hydration mismatch.
 */
export const CLERK_ENABLED = IS_PRODUCTION || Boolean(publishableKey);

/* Where the entry flow lives. Kept here so the proxy, the landing page, the
   sign-in card and the sign-out redirect all agree on one spelling of each path.

   `/welcome` is the front door: opening the site with no session lands there, and
   signing out returns there. It is public — it has to be, since it is what an
   anonymous visitor is shown — and it holds the Login button that leads into
   `/sign-in`, which in turn links on to `/sign-up`. */
export const WELCOME_PATH = "/welcome";
export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";

/**
 * Marks a visitor who chose "Continue without signing in" while Clerk was not
 * configured.
 *
 * This is *not* a second authentication system and proves nothing about who the
 * visitor is — it only records that they took that button on the sign-in page, so
 * the app can open at the feed instead of bouncing back. It unlocks exactly what
 * an anonymous visitor could already read: the public job feed. The admin
 * dashboard still needs the API's own bearer token and `requireAdmin`, and
 * resume/recommendations still need the profile token, both checked server-side.
 *
 * It exists so the entry flow is complete for a checkout with no Clerk instance.
 * It persists across browser restarts until the visitor signs out, so the keyless
 * path behaves like the other two. With Clerk configured the real session takes
 * over and this is never read. Production cannot reach this path at all —
 * `CLERK_ENABLED` is true there unconditionally, and `proxy.ts` refuses to serve a
 * production deployment whose keys are missing.
 */
export const GUEST_COOKIE = "jia.guest";

/**
 * Reduce an untrusted `redirect_url` to a same-origin path, or `null`.
 *
 * The value arrives in a query string, so anyone can choose it. Without this an
 * attacker could hand out `/sign-in?redirect_url=https://evil.example` and have
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
