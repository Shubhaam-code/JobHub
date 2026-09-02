"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileUp, LayoutDashboard, Search, Settings, Sparkles } from "lucide-react";

import { DashboardSignOut } from "@/components/dashboard-sign-out";

/**
 * The dashboard's own navigation.
 *
 * Every row is a page that exists and does something real. The reference also
 * shows "Applied Jobs" and "Saved Jobs"; neither is here, because nothing in the
 * API records an application or a bookmark — applying leaves for the employer's
 * own link, and there is no saved-job collection to list. A row that opened an
 * empty screen forever would look like a broken feature rather than an absent
 * one.
 */
const NAV_ITEMS = [
  { label: "Overview", href: "/dashboard", icon: LayoutDashboard },
  { label: "Browse Jobs", href: "/jobs", icon: Search },
  { label: "Recommended Jobs", href: "/recommended-jobs", icon: Sparkles },
  { label: "Upload Resume", href: "/dashboard/resume", icon: FileUp },
  { label: "Profile Settings", href: "/dashboard/profile", icon: Settings },
];

/**
 * Sidebar-and-content shell shared by every dashboard screen.
 *
 * The sidebar is a card that becomes a wrapping row of chips below `lg`, so a
 * phone gets the same set of destinations without a drawer to open. Each page
 * supplies its own heading — the shell is only the frame.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  /* Exact match: `/dashboard` is a prefix of every other dashboard route, so a
     `startsWith` test would leave Overview lit on all of them. */
  const isActive = (href: string) => pathname === href;

  return (
    /* `grid-cols-1` rather than the implicit single track: an implicit `auto`
       track is floored at its items' min-content width, and the nav below is a
       row of `whitespace-nowrap` chips, so on a phone that floor was wider than
       the viewport and the whole column — headings and cards included — was
       clipped by the body's `overflow-x-hidden`. Tailwind's `grid-cols-1` is
       `minmax(0, 1fr)`, which caps the track at the available width. `min-w-0`
       on the sidebar keeps the same nav from pushing the track out again. */
    <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-4 px-3 py-6 sm:gap-6 sm:px-6 sm:py-8 lg:grid-cols-[15.5rem_1fr] lg:gap-8 lg:px-8 lg:py-10">
      <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <nav
          aria-label="Dashboard"
          className="rounded-lg border border-border bg-surface p-1.5 shadow-e1 sm:p-2.5"
        >
          {/* Wraps below `lg` instead of scrolling sideways: six destinations do
              not fit one phone row, and a hidden-scrollbar strip would leave
              Profile Settings and Logout off-screen with nothing to say so. */}
          <ul className="flex flex-wrap gap-1 lg:flex-col lg:flex-nowrap">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;

              return (
                <li key={item.href} className="shrink-0 lg:shrink">
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-10 items-center gap-2 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors duration-150 sm:min-h-11 sm:gap-2.5 sm:px-3 sm:text-sm pointer-fine:min-h-10 ${
                      active
                        ? "bg-primary-soft font-semibold text-primary-strong"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Icon
                      className={`size-3.5 shrink-0 sm:size-4 ${active ? "text-primary" : ""}`}
                      aria-hidden="true"
                    />
                    {item.label}
                  </Link>
                </li>
              );
            })}

            <li className="shrink-0 border-border lg:mt-1 lg:shrink lg:border-t lg:pt-1">
              <DashboardSignOut />
            </li>
          </ul>
        </nav>
      </aside>

      <div className="min-w-0">{children}</div>
    </div>
  );
}
