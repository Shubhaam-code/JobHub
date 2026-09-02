"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { LogOut, Menu, X } from "lucide-react";

import { ClerkSignOutRow, ClerkUserButton } from "@/components/clerk-account-control";
import { CLERK_ENABLED } from "@/lib/clerk";
import { leaveAsGuest } from "@/lib/guest-actions";
import { DURATION, EASE_IN, EASE_OUT } from "@/lib/motion";

/* Real pages, not in-page anchors: browsing and filtering now live on /jobs, so
   every item here navigates and reads its active state from the pathname. */
const NAV_LINKS = [
  { label: "Home", href: "/" },
  { label: "Jobs", href: "/jobs" },
  { label: "Recommended", href: "/recommended-jobs" },
  { label: "Dashboard", href: "/dashboard" },
];

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();

  /* No admin special-casing any more: the console lives in the `(admin)` route
     group, which has its own layout and its own dark sidebar, so this header is
     never rendered there. */

  /* `/` would otherwise match everything, so it is the one exact comparison.
     `/jobs` stays lit on a job detail page, which is where the reader came from. */
  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  /* The header earns its hairline and shadow only once there is content behind
     it. At rest it stays flush with the page. */
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  /* Closing on navigation is done from each link's own onClick rather than an
     effect on `pathname`: setting state from an effect cascades an extra render
     of the whole header on every route change. */

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-[border-color,box-shadow,background-color] duration-200 ${
        scrolled
          ? "border-border bg-surface/90 shadow-e1 supports-[backdrop-filter]:backdrop-blur-md"
          : "border-border/60 bg-surface"
      }`}
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-on-primary"
      >
        Skip to content
      </a>

      {/* 64px on mobile, 72px from lg — the taller bar gives the 44px mark real
          breathing room without tipping into an oversized nav. */}
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-3 sm:gap-5 sm:px-4 md:gap-8 md:px-6 lg:h-18 lg:px-8">
        <Link
          href="/"
          className="group flex min-h-11 shrink-0 items-center rounded-md"
          aria-label="JobHub home"
        >
          {/* The full lockup, so the wordmark is part of the artwork instead of
              being re-set in Lexend beside it — two "JobHub"s in two different
              typefaces was the old arrangement.

              1446x359 is the file's real size: `w-auto` derives the width from
              this ratio, so a wrong pair here is what stretches the mark. Height
              tracks the bar (h-16 -> h-18), which puts the wordmark at ~18-21px,
              about where the text it replaced sat. */}
          <Image
            src="/logo-lockup.png"
            alt=""
            width={1446}
            height={359}
            sizes="145px"
            priority
            className="h-7 w-auto shrink-0 sm:h-8 lg:h-9"
          />
        </Link>

        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-0.5">
            {NAV_LINKS.map((link) => {
              const active = isActive(link.href);
              return (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors duration-150 pointer-fine:min-h-9 ${
                      active
                        ? "text-primary-strong"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {link.label}
                    {/* Shared layoutId: the rule slides between links instead of
                        cutting, which is the whole point of animating it. */}
                    {active && (
                      <motion.span
                        layoutId="nav-active"
                        aria-hidden="true"
                        className="absolute inset-x-3 -bottom-1 h-[2px] rounded-full bg-primary"
                        transition={{
                          duration: reduceMotion ? 0 : DURATION.state,
                          ease: EASE_OUT,
                        }}
                      />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href="/jobs"
            className="hidden min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,transform,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10 md:inline-flex"
          >
            Find Jobs
          </Link>

          {/* Sign-out has to be reachable from somewhere, and the account menu is
              where people look for it. Only rendered with Clerk configured — the
              flag is a build-time constant, so this branch is fixed and the hook
              inside is never called without a provider above it. */}
          {CLERK_ENABLED && <ClerkUserButton />}

          {/* The same exit for the keyless path, which has no Clerk session to end
              — it just clears the marker and goes back to /welcome, the same place
              `afterSignOutUrl` sends a real sign-out. */}
          {!CLERK_ENABLED && (
            <form action={leaveAsGuest}>
              <button
                type="submit"
                className="hidden min-h-11 items-center rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground pointer-fine:min-h-10 md:inline-flex"
              >
                Sign out
              </button>
            </form>
          )}

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="-mr-2 grid size-11 place-items-center rounded-md text-foreground transition-colors duration-150 hover:bg-muted md:hidden"
          >
            {menuOpen ? (
              <X className="size-5" aria-hidden="true" />
            ) : (
              <Menu className="size-5" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {menuOpen && (
          <motion.div
            id="mobile-nav"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { height: 0, opacity: 0, transition: { duration: DURATION.exit, ease: EASE_IN } }
            }
            transition={{ duration: DURATION.enter, ease: EASE_OUT }}
            className="overflow-hidden border-t border-border bg-surface shadow-e3 md:hidden"
          >
            <nav aria-label="Mobile">
              <ul className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-3 py-3 sm:px-4 sm:py-3 md:px-6">
                {NAV_LINKS.map((link) => {
                  const active = isActive(link.href);
                  return (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        onClick={() => setMenuOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={`flex min-h-12 items-center rounded-md px-3 text-base font-medium transition-colors duration-150 ${
                          active
                            ? "bg-primary-soft text-primary-strong"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
                <li className="pt-1">
                  <Link
                    href="/jobs"
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-12 items-center justify-center rounded-md bg-primary px-4 text-base font-semibold text-on-primary transition-transform duration-150 active:scale-[0.98]"
                  >
                    Find Jobs
                  </Link>
                </li>
                {CLERK_ENABLED && <ClerkSignOutRow onNavigate={() => setMenuOpen(false)} />}
                {!CLERK_ENABLED && (
                  <li>
                    <form action={leaveAsGuest}>
                      <button
                        type="submit"
                        onClick={() => setMenuOpen(false)}
                        className="flex min-h-12 w-full items-center gap-2 rounded-md px-3 text-base font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                      >
                        <LogOut className="size-4" aria-hidden="true" />
                        Sign out
                      </button>
                    </form>
                  </li>
                )}
              </ul>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
