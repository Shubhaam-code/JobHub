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
 * The sidebar is a card that becomes a horizontal scroller below `lg`, so a
 * phone gets the same set of destinations without a drawer to open. Each page
 * supplies its own heading — the shell is only the frame.
 */
export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  /* Exact match: `/dashboard` is a prefix of every other dashboard route, so a
     `startsWith` test would leave Overview lit on all of them. */
  const isActive = (href: string) => pathname === href;

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 sm:px-6 lg:grid-cols-[15.5rem_1fr] lg:gap-8 lg:px-8 lg:py-10">
      <aside className="lg:sticky lg:top-24 lg:self-start">
        <nav
          aria-label="Dashboard"
          className="rounded-lg border border-border bg-surface p-2.5 shadow-e1"
        >
          <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {NAV_ITEMS.map((item) => {
              const active = isActive(item.href);
              const Icon = item.icon;

              return (
                <li key={item.href} className="shrink-0 lg:shrink">
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-11 items-center gap-2.5 rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 pointer-fine:min-h-10 ${
                      active
                        ? "bg-primary-soft font-semibold text-primary-strong"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground"
                    }`}
                  >
                    <Icon
                      className={`size-4 shrink-0 ${active ? "text-primary" : ""}`}
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
