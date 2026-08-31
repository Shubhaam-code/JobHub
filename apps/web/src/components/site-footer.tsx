import Image from "next/image";

const FOOTER_LINKS = [
  { label: "Jobs", href: "#jobs" },
  { label: "Internships", href: "#internships" },
  { label: "Latest opportunities", href: "#opportunities" },
];

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between sm:gap-16">
          <div className="max-w-sm">
            {/* Same mark, size and radius as the header, so the brand reads as
                one treatment rather than two similar ones. */}
            <div className="flex items-center gap-2.5">
              <Image
                src="/image.png"
                alt=""
                width={1312}
                height={1199}
                className="h-11 w-auto shrink-0"
              />
              <span className="font-heading text-[17px] leading-none font-semibold tracking-snug">
                JobFeed
              </span>
            </div>
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
                  <a
                    href={link.href}
                    className="inline-flex min-h-11 min-w-11 items-center text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground pointer-fine:min-h-9 sm:justify-end"
                  >
                    {link.label}
                  </a>
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
