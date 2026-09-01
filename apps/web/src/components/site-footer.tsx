import Image from "next/image";
import Link from "next/link";

/* Real destinations only. There is no "Companies" or "About" page in this
   product, and a footer link to a route that does not exist is worse than a
   shorter footer. */
const FOOTER_LINKS = [
  { label: "Browse jobs", href: "/jobs" },
  { label: "Recommended for you", href: "/recommended-jobs" },
  { label: "Upload resume", href: "/dashboard/resume" },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between sm:gap-16">
          <div className="max-w-sm">
            {/* Same lockup and height as the header, so the brand reads as one
                treatment rather than two similar ones. `alt` carries the name
                here because, unlike in the header, there is no wrapping link to
                hang an accessible label on. */}
            <Image
              src="/logo-lockup.png"
              alt="JobHub"
              width={1446}
              height={359}
              sizes="129px"
              className="h-8 w-auto"
            />
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Jobs and internships from public channels, listed by role, batch and location.
            </p>
          </div>

          <nav aria-label="Footer">
            {/* A <p>, not a heading: an 11px micro-label announced as "heading
                level 2" would overstate it, and the nav is already labelled. */}
            <p className="text-[11px] font-semibold tracking-label text-subtle-foreground uppercase">
              Browse
            </p>
            <ul className="mt-3 flex flex-col gap-0.5 sm:items-end">
              {FOOTER_LINKS.map((link) => (
                <li key={link.label} className="sm:self-end">
                  <Link
                    href={link.href}
                    className="inline-flex min-h-11 min-w-11 items-center text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground pointer-fine:min-h-9 sm:justify-end"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <p className="mt-10 border-t border-border pt-6 text-xs text-subtle-foreground">
          © {new Date().getFullYear()} JobFeed. Real-time opportunity aggregator.
        </p>
      </div>
    </footer>
  );
}
