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

/* "Jobs" and "Internships" both land on the listings section and preselect the
   matching tab there — the explorer reads the hash, so these are real controls
   rather than decorative labels. Because the hash *is* the current location,
   both this header and the explorer can derive their active state from it
   independently, with no shared state to keep in sync. */
const NAV_LINKS = [
  { label: "Jobs", href: "#jobs" },
  { label: "Internships", href: "#internships" },
];

/* Pages rather than in-page anchors, so these navigate with `next/link` and
   read their active state from the pathname instead of the hash. */
const ROUTE_LINKS = [{ label: "Recommended", href: "/recommended-jobs" }];

export function SiteHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [activeHash, setActiveHash] = useState("");
  const pathname = usePathname();
  const reduceMotion = useReducedMotion();

  /* The section anchors live on the home page. From any other route a bare
     "#jobs" would only rewrite the hash, so it needs the home path in front. */
  const onHome = pathname === "/";
  const sectionHref = (hash: string) => (onHome ? hash : `/${hash}`);

  /* The admin dashboard is not part of the visitor-facing site, so it keeps only
     the brand: browsing the feed is not what anyone is there to do, and every
     one of these links would navigate an operator out of the tool mid-task. */
  const onAdmin = pathname === "/admin";

  /* Read on the client only: the server has no hash, so deriving this during
     render would mismatch on hydration. */
  useEffect(() => {
    const syncFromHash = () => setActiveHash(window.location.hash);
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

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

  return (
    <header
      className={`sticky top-0 z-50 border-b transition-[border-color,box-shadow,background-color] duration-200 ${
        scrolled
          ? "border-border bg-background/85 shadow-e1 supports-[backdrop-filter]:backdrop-blur-md"
          : "border-transparent bg-background"
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
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-5 px-4 sm:gap-8 sm:px-6 lg:h-18 lg:px-8">
        <Link
          href="/"
          className="group flex min-h-11 shrink-0 items-center gap-2.5 rounded-md"
          aria-label="JobFeed home"
        >
          {/* Intrinsic size passed so Next can build a sharp srcset; `h-11 w-auto`
              keeps the PNG's own aspect ratio and its transparency. The height
              matches the link's own min-h-11, so the h-16 header is unaffected.
              1312x1199 is the file's real size — declaring anything else makes
              `w-auto` resolve to the wrong width and stretches the mark. `sizes`
              is the rendered width (44px tall / 1.094), so the browser picks a
              ~64px render instead of the 1920px default for fixed images. */}
          <Image
            src="/image.png"
            alt=""
            width={1312}
            height={1199}
            sizes="48px"
            priority
            className="h-11 w-auto shrink-0"
          />
          <span className="font-heading text-[17px] leading-none font-semibold tracking-snug">
            JobFeed
          </span>
        </Link>

        <nav aria-label="Main" className={onAdmin ? "hidden" : "hidden md:block"}>
          <ul className="flex items-center gap-0.5">
            {NAV_LINKS.map((link) => {
              // Only on the home page: the hash targets sections that exist
              // there, so "Jobs" must not look active on another route.
              const active = pathname === "/" && activeHash === link.href;
              return (
                <li key={link.label}>
                  <a
                    href={sectionHref(link.href)}
                    aria-current={active ? "true" : undefined}
                    className={`relative flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors duration-150 pointer-fine:min-h-9 ${
                      active
                        ? "text-foreground"
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
                  </a>
                </li>
              );
            })}
            {ROUTE_LINKS.map((link) => {
              const active = pathname === link.href;
              return (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors duration-150 pointer-fine:min-h-9 ${
                      active
                        ? "text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    {link.label}
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
          {!onAdmin && (
            <a
              href={sectionHref("#opportunities")}
              className="hidden min-h-11 items-center rounded-md bg-primary px-4 text-sm font-semibold text-on-primary shadow-e1 transition-[background-color,transform,box-shadow] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] pointer-fine:min-h-10 md:inline-flex"
            >
              Find opportunities
            </a>
          )}

          {/* Sign-out has to be reachable from somewhere, and the account menu is
              where people look for it. Only rendered with Clerk configured — the
              flag is a build-time constant, so this branch is fixed and the hook
              inside is never called without a provider above it. */}
          {CLERK_ENABLED && <ClerkUserButton />}

          {/* The same exit for the keyless path, which has no Clerk session to end
              — it just clears the landing-page marker and goes back to /welcome. */}
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

          {/* Nothing left for it to open on the dashboard — the menu carries the
              same site links the bar above does. */}
          {!onAdmin && (
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
          )}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {menuOpen && !onAdmin && (
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
              <ul className="mx-auto flex w-full max-w-6xl flex-col gap-1 px-4 py-3 sm:px-6">
                {NAV_LINKS.map((link) => {
                  const active = pathname === "/" && activeHash === link.href;
                  return (
                    <li key={link.label}>
                      <a
                        href={sectionHref(link.href)}
                        onClick={() => setMenuOpen(false)}
                        aria-current={active ? "true" : undefined}
                        className={`flex min-h-12 items-center rounded-md px-3 text-base font-medium transition-colors duration-150 ${
                          active
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {link.label}
                      </a>
                    </li>
                  );
                })}
                {ROUTE_LINKS.map((link) => {
                  const active = pathname === link.href;
                  return (
                    <li key={link.label}>
                      <Link
                        href={link.href}
                        onClick={() => setMenuOpen(false)}
                        aria-current={active ? "page" : undefined}
                        className={`flex min-h-12 items-center rounded-md px-3 text-base font-medium transition-colors duration-150 ${
                          active
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {link.label}
                      </Link>
                    </li>
                  );
                })}
                <li className="pt-1">
                  <a
                    href={sectionHref("#opportunities")}
                    onClick={() => setMenuOpen(false)}
                    className="flex min-h-12 items-center justify-center rounded-md bg-primary px-4 text-base font-semibold text-on-primary transition-transform duration-150 active:scale-[0.98]"
                  >
                    Find opportunities
                  </a>
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
