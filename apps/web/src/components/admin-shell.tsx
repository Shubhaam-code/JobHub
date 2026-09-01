"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Briefcase, ExternalLink, LayoutDashboard, LogOut, Radio } from "lucide-react";

import { clearAdminToken, type AdminUser } from "@/lib/admin-api";

/**
 * The admin console's own navigation.
 *
 * The reference design also lists Applications, Resumes, Companies, Users and
 * Settings. None of them are here because none of them exist: the API has no
 * applications collection, resume PDFs are parsed and discarded rather than
 * stored, and there is no companies, users or settings endpoint. A nav row leading
 * to an invented screen would be the one thing this console must not do, so the
 * list is exactly the three screens that read real data.
 */
const NAV_ITEMS = [
  { label: "Dashboard", href: "/admin", icon: LayoutDashboard },
  { label: "Jobs", href: "/admin/jobs", icon: Briefcase },
  { label: "Channels", href: "/admin/channels", icon: Radio },
] as const;

const ROW_BASE =
  "inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 lg:min-h-10";

/**
 * Dark-sidebar frame for every admin screen.
 *
 * Rendered by `AdminGate` once the API has confirmed an ADMIN account, so nothing
 * in here re-checks anything — the authority is the server's `requireAdmin`, which
 * refuses a non-admin caller whatever the browser draws.
 *
 * One element does both breakpoints: the sidebar is a horizontal scrolling band
 * across the top on a narrow screen and a full-height column from `lg`, so the nav
 * exists once rather than as two copies that can disagree.
 */
export function AdminShell({
  user,
  onSignedOut,
  children,
}: {
  user: AdminUser;
  onSignedOut: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <div className="flex flex-1 flex-col lg:flex-row">
      <aside className="bg-inverse text-on-inverse lg:flex lg:w-60 lg:shrink-0 lg:flex-col">
        <div className="flex items-center gap-2.5 border-b border-inverse-border px-4 py-3.5 lg:px-4 lg:py-4">
          {/* The icon on its own, not the lockup: this sidebar is the product's
              one dark surface, and the lockup's wordmark is site ink (#1c1917),
              which would be invisible on it. The label beside it carries the
              name instead, so the image stays decorative. 378x359 is the file's
              real size. */}
          <Image
            src="/logo-mark.png"
            alt=""
            width={378}
            height={359}
            sizes="34px"
            className="h-8 w-auto"
          />
          <span className="min-w-0">
            <span className="block font-heading text-sm leading-tight font-semibold">
              JobFeed Admin
            </span>
            {/* Whose session this is. Worth the line: an admin token outlives the
                browser tab, so it should be visible which account is acting. */}
            <span className="block truncate text-xs text-on-inverse-muted">{user.email}</span>
          </span>
        </div>

        <nav
          aria-label="Admin"
          className="flex gap-1 overflow-x-auto px-3 py-3 lg:flex-1 lg:flex-col lg:overflow-visible lg:py-4"
        >
          {NAV_ITEMS.map((item) => {
            /* Exact match, not `startsWith`: /admin is a prefix of every other
               route here, so a prefix test would leave Dashboard lit on all of
               them. */
            const current = pathname === item.href;
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`${ROW_BASE} ${
                  current
                    ? "bg-primary text-on-primary"
                    : "text-on-inverse-muted hover:bg-inverse-elevated hover:text-on-inverse"
                }`}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}

          {/* This console has no site header, so without this row there is no way
              back to the public site from inside it. */}
          <Link
            href="/"
            className={`${ROW_BASE} text-on-inverse-muted hover:bg-inverse-elevated hover:text-on-inverse lg:mt-auto`}
          >
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            View site
          </Link>

          <button
            type="button"
            onClick={() => {
              clearAdminToken();
              onSignedOut();
            }}
            className={`${ROW_BASE} text-on-inverse-muted hover:bg-inverse-elevated hover:text-on-inverse`}
          >
            <LogOut className="size-4 shrink-0" aria-hidden="true" />
            Logout
          </button>
        </nav>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">{children}</div>
      </div>
    </div>
  );
}
