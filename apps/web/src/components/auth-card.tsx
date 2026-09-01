import Image from "next/image";
import Link from "next/link";

import { SIGN_IN_PATH } from "@/lib/clerk";

/**
 * The card every sign-in screen is drawn in.
 *
 * One shell for three screens — user sign-in, sign-up and admin sign-in — so the
 * logo, the heading scale and the card chrome are defined once instead of three
 * times drifting apart.
 */
export function AuthCard({
  title,
  subtitle,
  tab,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  /** Which of the two doors this screen is. Omitted on sign-up, which is neither. */
  tab?: "seeker" | "admin";
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="w-full max-w-[26.5rem]">
      <div className="rounded-xl border border-border bg-surface p-6 shadow-e3 sm:p-8">
        <div className="text-center">
          {/* The full lockup, same file as the header and footer. `alt` names the
              brand rather than being empty: this mark stands alone above the
              form, so with an empty alt the brand would never be announced.
              1446x359 is its real size, so `w-auto` resolves the right width. */}
          <Image
            src="/logo-lockup.png"
            alt="JobHub"
            width={1446}
            height={359}
            sizes="145px"
            priority
            className="mx-auto h-9 w-auto"
          />
          <h1 className="mt-5 font-heading text-2xl leading-tight font-semibold tracking-display text-foreground">
            {title}
          </h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
        </div>

        {tab && <AuthTabs active={tab} />}

        <div className={tab ? "mt-6" : "mt-7"}>{children}</div>
      </div>

      {footer && (
        <div className="mt-5 text-center text-[13px] leading-relaxed text-subtle-foreground">
          {footer}
        </div>
      )}
    </div>
  );
}

/**
 * Job Seeker | Admin.
 *
 * Links, not a client-side toggle, because the two are separate authentication
 * systems living on separate routes: Clerk owns every normal account, and the
 * admin form gets its authority from the API's own bearer token. Switching tabs
 * is therefore a navigation, and signing in through one can never grant the
 * other.
 */
function AuthTabs({ active }: { active: "seeker" | "admin" }) {
  const tabs = [
    { id: "seeker", label: "Job Seeker", href: SIGN_IN_PATH },
    { id: "admin", label: "Admin", href: "/admin" },
  ] as const;

  return (
    <div
      role="tablist"
      aria-label="Sign in as"
      className="mt-6 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
    >
      {tabs.map((item) => {
        const current = item.id === active;

        return (
          <Link
            key={item.id}
            href={item.href}
            role="tab"
            aria-selected={current}
            className={`inline-flex min-h-10 items-center justify-center rounded-md text-sm font-semibold transition-[background-color,box-shadow,color] duration-150 ${
              current
                ? "bg-surface text-foreground shadow-e1"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
