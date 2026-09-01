"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Menu, X } from "lucide-react";

import { SIGN_IN_PATH, WELCOME_PATH } from "@/lib/clerk";

/**
 * The landing page's own navigation bar.
 *
 * Separate from `SiteHeader` on purpose. That header is the signed-in app's: its
 * links are Home / Jobs / Recommended / Dashboard, three of which are gated, and
 * it carries the account menu. This one belongs to a public page whose reader has
 * no session yet, so it is the wordmark, a short set of links and one Login
 * button — the shape the reference design shows.
 *
 * Every link goes somewhere real. There is no "Blog" item: this project has no
 * blog and no endpoint that could serve one, and a nav link to a page that does
 * not exist is a dead end rather than a design detail.
 */
const NAV_LINKS = [
  { label: "Home", href: WELCOME_PATH },
  { label: "Jobs", href: "/jobs" },
  { label: "How it works", href: "#how-it-works" },
];

export function WelcomeNav() {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [menuOpen]);

  return (
    <header className="relative z-50">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-on-primary"
      >
        Skip to content
      </a>

      <div className="mx-auto flex h-18 w-full max-w-[88rem] items-center gap-6 px-4 sm:px-6 lg:h-24 lg:px-8">
        <Link
          href={WELCOME_PATH}
          className="flex min-h-11 shrink-0 items-center rounded-md md:flex-1"
          aria-label="JobHub home"
        >
          {/* Same lockup as the app header, one size step up because this bar is
              taller (h-18 -> h-24). 1446x359 is the file's real size, which is
              what `w-auto` derives the width from. */}
          <Image
            src="/logo-lockup.png"
            alt=""
            width={1446}
            height={359}
            sizes="161px"
            priority
            className="h-9 w-auto shrink-0 lg:h-10"
          />
        </Link>

        {/* Centred on the bar itself, as in the reference: the wordmark and the
            button flank it as equal-basis columns, so the link row sits on the
            bar's midline rather than in whatever space the two happen to leave. */}
        <nav aria-label="Main" className="hidden md:block">
          <ul className="flex items-center gap-1 lg:gap-14">
            {NAV_LINKS.map((link) => (
              <li key={link.label}>
                <Link
                  href={link.href}
                  className="flex min-h-11 items-center rounded-md px-3 text-[15px] font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground lg:px-2 lg:text-[17px] pointer-fine:min-h-10"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="ml-auto flex items-center gap-2 md:ml-0 md:flex-1 md:justify-end">
          {/* The one call to action up here. `/sign-in` then links on to
              `/sign-up`, so both halves of the flow are one click away. */}
          <Link
            href={SIGN_IN_PATH}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-primary px-6 text-[15px] font-semibold text-on-primary shadow-e1 transition-[background-color,box-shadow,transform] duration-150 hover:bg-primary-strong hover:shadow-e2 active:scale-[0.98] sm:px-8 lg:min-h-13 lg:text-[17px]"
          >
            Login
          </Link>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-controls="welcome-nav-menu"
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

      {menuOpen && (
        <nav
          id="welcome-nav-menu"
          aria-label="Mobile"
          className="border-b border-border bg-surface shadow-e3 md:hidden"
        >
          <ul className="mx-auto flex w-full max-w-[88rem] flex-col gap-1 px-4 py-3 sm:px-6">
            {NAV_LINKS.map((link) => (
              <li key={link.label}>
                <Link
                  href={link.href}
                  onClick={() => setMenuOpen(false)}
                  className="flex min-h-12 items-center rounded-md px-3 text-base font-medium text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </header>
  );
}
