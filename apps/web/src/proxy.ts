import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextMiddleware, type NextRequest } from "next/server";

import {
  GUEST_COOKIE,
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  WELCOME_PATH,
  safeRedirectPath,
} from "@/lib/clerk";

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

/** Send a visitor with no session to the landing page, remembering where they were headed. */
function toWelcome(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const welcome = new URL(WELCOME_PATH, request.url);
  /* `/` is where sign-in lands by default, so recording it would only add noise
     to the URL. Anything deeper is worth coming back to. */
  if (pathname !== "/") welcome.searchParams.set("redirect_url", `${pathname}${search}`);
  return NextResponse.redirect(welcome);
}

/** Send a visitor who already has a way in off the landing page and into the app. */
function toApp(request: NextRequest) {
  const target = safeRedirectPath(request.nextUrl.searchParams.get("redirect_url")) ?? "/";
  return NextResponse.redirect(new URL(target, request.url));
}

/**
 * Same routing without a Clerk instance, so the landing page is still the first
 * thing a visitor sees. There is no session to check, so it reads the marker the
 * landing page's "Continue as User" sets — which authenticates nobody and grants
 * only the public feed. Unreachable in production: the missing key throws above.
 */
const keylessGate: NextMiddleware = (request) => {
  const { pathname } = request.nextUrl;

  if (request.cookies.has(GUEST_COOKIE)) {
    return pathname === WELCOME_PATH ? toApp(request) : NextResponse.next();
  }

  return isPublic(pathname) ? NextResponse.next() : toWelcome(request);
};

/**
 * Two redirects, each landing somewhere the other one leaves alone — that is why
 * there is no loop:
 *
 *   signed out → `/`         → `/welcome`
 *   signed out → `/jobs/abc` → `/welcome?redirect_url=/jobs/abc`
 *   signed in  → `/welcome`  → `/` (or back to `redirect_url`)
 *   signed in  → `/`         → renders
 *   anyone     → `/admin`    → renders the existing admin sign-in form
 *
 * `/welcome` is public, so the signed-out redirect terminates there. `/` is
 * gated, so the signed-in redirect terminates there too.
 */
const gate = clerkMiddleware(async (auth, request) => {
  const { pathname } = request.nextUrl;
  const { userId } = await auth();

  if (userId) {
    /* Only the landing page is wrong for a signed-in visitor; every other route
       is theirs to use. Honour `redirect_url` so someone who was sent to
       /welcome from a deep link ends up back at it. */
    return pathname === WELCOME_PATH ? toApp(request) : NextResponse.next();
  }

  return isPublic(pathname) ? NextResponse.next() : toWelcome(request);
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
