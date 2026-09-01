import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextMiddleware, type NextRequest } from "next/server";

import { GUEST_COOKIE, SIGN_IN_PATH, SIGN_UP_PATH, WELCOME_PATH } from "@/lib/clerk";

/**
 * Server-side authentication gate.
 *
 * Next 16 renamed `middleware.ts` to `proxy.ts`; because `app` lives under
 * `src/`, this file has to sit at `src/proxy.ts` — the same level as `src/app`.
 *
 * This is the only place that decides whether a signed-out visitor may see the
 * application. It runs before any route renders, so there is no flash of gated
 * content and no reliance on a component choosing to hide something.
 *
 * The admin dashboard is deliberately *not* gated here. It has its own
 * authentication — an HMAC bearer token from `POST /api/auth/login`, checked
 * server-side by `requireAdmin` on every `/api/admin/*` request — and that stays
 * the sole authority on who is an admin. Letting Clerk in front of it would both
 * duplicate the auth system and lock out existing admin sessions, so `/admin`
 * passes through untouched and draws its own sign-in form. A Clerk user is never
 * an admin: nothing links a Clerk identity to a Mongo `User`, so the API answers
 * 401/403 to them no matter what the browser renders.
 */
const PUBLIC_PREFIXES = [
  /* The landing page. It is what a visitor with no session is shown, so gating it
     would be a redirect loop. */
  WELCOME_PATH,
  /* Never redirected away from, even with a live session. Clerk's own
     sub-routes (`sso-callback`, `factor-one`, …) activate the session part-way
     through the flow, so bouncing a signed-in request off these paths would
     break OAuth and multi-factor sign-in. */
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  "/admin",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/* `CLERK_SECRET_KEY` is read at runtime, not inlined at build time, so a
   deployment can have been built with keys and started without them. Failing
   here is the fail-closed choice: an unverifiable session must not become an
   open door. Development stays runnable without a Clerk instance — the gate
   below still puts the landing page first, it just has no session to verify. */
const configured = Boolean(
  process.env.CLERK_SECRET_KEY?.trim() && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim(),
);

if (!configured && process.env.NODE_ENV === "production") {
  throw new Error(
    "Clerk keys are missing at runtime. Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and " +
      "CLERK_SECRET_KEY (see apps/web/.env.example). Refusing to serve the " +
      "application with its authentication gate disabled.",
  );
}

/**
 * Where a visitor with no session goes.
 *
 * Opening the site is a different intent from following a link into it, so the two
 * are answered differently. Someone arriving at `/` has asked for nothing in
 * particular and gets the landing page, which is what introduces the product and
 * holds the Login button. Someone who followed a link to `/jobs/abc` has asked for
 * a specific page, so they go straight to the login form with that destination
 * recorded — dropping them on a marketing page instead would lose it.
 */
function toEntry(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (pathname === "/") return NextResponse.redirect(new URL(WELCOME_PATH, request.url));

  const signIn = new URL(SIGN_IN_PATH, request.url);
  signIn.searchParams.set("redirect_url", `${pathname}${search}`);
  return NextResponse.redirect(signIn);
}

/**
 * Same routing without a Clerk instance, so the landing page is still the first
 * thing a visitor sees. There is no session to check, so it reads the marker the
 * sign-in page's "Continue without signing in" sets — which authenticates nobody
 * and grants only the public feed. Unreachable in production: the missing key
 * throws above.
 */
const keylessGate: NextMiddleware = (request) => {
  const { pathname } = request.nextUrl;

  if (request.cookies.has(GUEST_COOKIE)) return NextResponse.next();

  return isPublic(pathname) ? NextResponse.next() : toEntry(request);
};

/**
 * One redirect, landing on a path the gate itself leaves alone — that is why
 * there is no loop:
 *
 *   signed out → `/`         → `/welcome`
 *   signed out → `/jobs/abc` → `/sign-in?redirect_url=/jobs/abc`
 *   signed in  → `/`         → renders the feed
 *   anyone     → `/welcome`  → renders the landing page
 *   anyone     → `/sign-in`  → renders the sign-in card
 *   anyone     → `/admin`    → renders the admin sign-in form
 *
 * Both redirect targets are public, so the signed-out redirect terminates. A
 * signed-in visitor is not bounced off any of them either: `/welcome` is a public
 * page anyone may read, and Clerk's flow re-enters its own `/sign-in` sub-paths
 * with a live session — the widget itself forwards them on.
 */
const gate = clerkMiddleware(async (auth, request) => {
  const { pathname } = request.nextUrl;
  const { userId } = await auth();

  if (userId) return NextResponse.next();

  return isPublic(pathname) ? NextResponse.next() : toEntry(request);
});

export default configured ? gate : keylessGate;

export const config = {
  /* Without a matcher the proxy runs on every request, static assets included,
     and the redirect above would strip the page's own CSS and images. This skips
     Next's internals and anything that looks like a file — `/image.png`, the
     fonts, the manifest — while still covering `/__clerk/*`, which Clerk uses
     for its handshake. */
  matcher: [
    "/((?!_next/static|_next/image|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
  ],
};
