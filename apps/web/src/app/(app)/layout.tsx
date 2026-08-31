import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";

/**
 * Chrome for the application itself.
 *
 * This markup used to live in the root layout, which meant every route got the
 * site header — including the sign-in pages, where its nav is wrong: "Jobs" and
 * "Find opportunities" are hash links to feed sections that are not on the page,
 * and "Recommended" bounces a signed-out visitor straight back. Moving it into a
 * route group scopes it to the pages it belongs to. `(app)` is a grouping folder,
 * so no URL changes: `(app)/page.tsx` is still `/`, `(app)/jobs/[id]` is still
 * `/jobs/[id]`, and so on.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
