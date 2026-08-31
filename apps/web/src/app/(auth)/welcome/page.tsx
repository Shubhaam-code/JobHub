import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ShieldCheck, UserRound } from "lucide-react";

import { CLERK_ENABLED, SIGN_IN_PATH, safeRedirectPath } from "@/lib/clerk";
import { enterAsGuest } from "@/lib/guest-actions";

export const metadata: Metadata = {
  title: "Sign in — JobFeed",
  description:
    "Sign in to JobFeed to see jobs and internships matched to your profile, or open the admin dashboard.",
};

/* One shape for both options so they read as a set. `items-center` is what keeps
   the icon and the arrow optically centred against the two lines of text —
   top-aligning them leaves the arrow floating near the title. */
const CARD_BASE =
  "group flex items-center gap-4 rounded-xl p-5 text-left transition-[background-color,border-color,box-shadow] duration-150 sm:px-6";

const USER_CARD = `${CARD_BASE} bg-primary shadow-e2 hover:bg-primary-strong hover:shadow-e3`;

function UserCardBody() {
  return (
    <>
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-lg bg-on-primary/15 text-on-primary"
      >
        <UserRound className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-heading text-[15px] font-semibold tracking-snug text-on-primary">
          Continue as User
        </span>
        {/* /85 rather than /80: at 14px on a saturated fill, the lower value
            starts costing legibility for the sake of a hierarchy the weight
            difference already carries. */}
        <span className="mt-0.5 block text-sm leading-relaxed text-on-primary/85">
          Find jobs and internships matched to your profile
        </span>
      </span>
      <ArrowRight
        aria-hidden="true"
        className="size-4 shrink-0 text-on-primary/90 transition-transform duration-150 group-hover:translate-x-0.5"
      />
    </>
  );
}

/**
 * The first page a signed-out visitor sees.
 *
 * Two doors, and they are genuinely separate systems rather than two buttons on
 * one. "Continue as User" hands off to Clerk, which owns every normal account.
 * "Admin Login" goes to `/admin`, which draws the existing operator sign-in form
 * and gets its authority from the API's own bearer token — so signing in as a
 * user can never confer admin access, whichever door you came through.
 *
 * Reaching this page at all means the proxy found no Clerk session, so there is
 * nothing to check here: `proxy.ts` sends a signed-in visitor straight back to
 * the application.
 */
export default async function WelcomePage({ searchParams }: PageProps<"/welcome">) {
  /* Set by the proxy when it intercepted a deep link. Sanitised again here rather
     than trusted: this value reaches us through a query string, so it is the
     visitor's to choose, and handing it to Clerk unchecked would turn our own
     sign-in flow into an open redirect. */
  const raw = (await searchParams).redirect_url;
  const nextPath = safeRedirectPath(Array.isArray(raw) ? raw[0] : raw);

  const signInHref = nextPath
    ? `${SIGN_IN_PATH}?redirect_url=${encodeURIComponent(nextPath)}`
    : SIGN_IN_PATH;

  return (
    <div className="w-full max-w-[30rem]">
      <div className="text-center">
        {/* Same mark as the header and footer, one file in `public/`. 1312x1199
            is its real size, so `w-auto` resolves to the right width instead of
            stretching it; `sizes` is the rendered width (48px tall / 1.094) so
            the browser fetches a ~64px render, not the 1920px default. */}
        <Image
          src="/image.png"
          alt=""
          width={1312}
          height={1199}
          sizes="64px"
          priority
          className="mx-auto h-12 w-auto"
        />

        {/* Capped at 2rem: the mark, the wordmark and two cards are already
            carrying the page, and a 40px heading in a 480px column turns
            "That Match You" into a second slab of type that fights them. */}
        <h1 className="mt-6 font-heading text-[clamp(1.625rem,1.1rem+2vw,2rem)] leading-[1.15] font-semibold tracking-display text-balance text-foreground">
          Find Opportunities That Match You
        </h1>
        {/* Narrower than the cards on purpose, so the rag stays even instead of
            leaving one short trailing line under a full-width block. */}
        <p className="mx-auto mt-3 max-w-[24rem] text-[15px] leading-relaxed text-muted-foreground text-pretty">
          Jobs and internships gathered from public channels, filtered to the ones open to your
          batch, role and location.
        </p>
      </div>

      {/* Stacked rather than side by side: the two options are not peers, and one
          column also removes any chance of horizontal overflow on a narrow
          screen. */}
      <div className="mt-8 flex flex-col gap-2.5">
        {CLERK_ENABLED ? (
          <Link href={signInHref} className={USER_CARD}>
            <UserCardBody />
          </Link>
        ) : (
          /* No Clerk instance in this checkout, so there is no sign-in form to
             send anyone to — but the landing page still has to be a door rather
             than a dead end. This grants only the public feed; see GUEST_COOKIE.
             A production build never reaches here, because the missing key stops
             it in `lib/clerk.ts`. */
          <form action={enterAsGuest}>
            <input type="hidden" name="next" value={nextPath ?? "/"} />
            <button type="submit" className={`w-full ${USER_CARD}`}>
              <UserCardBody />
            </button>
          </form>
        )}

        {/* Quiet on purpose. It is the way in for staff, not the other half of a
            choice most visitors are making. */}
        <Link
          href="/admin"
          className={`${CARD_BASE} border border-border bg-surface hover:border-border-strong hover:shadow-e1`}
        >
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-subtle-foreground"
          >
            <ShieldCheck className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-heading text-[15px] font-semibold tracking-snug text-foreground">
              Admin Login
            </span>
            <span className="mt-0.5 block text-sm leading-relaxed text-subtle-foreground">
              Manage jobs, users and platform data
            </span>
          </span>
          <ArrowRight
            aria-hidden="true"
            className="size-4 shrink-0 text-subtle-foreground transition-transform duration-150 group-hover:translate-x-0.5"
          />
        </Link>
      </div>

      {/* Answers the question the two cards leave open — there is no separate
          "create account" door, because Clerk's own form carries one. It also
          settles the page, which otherwise ends on a hard edge. */}
      <p className="mt-6 text-center text-[13px] leading-relaxed text-subtle-foreground">
        New here? You can create an account from the same screen.
      </p>
    </div>
  );
}
