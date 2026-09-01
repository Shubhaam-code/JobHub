/**
 * Chrome for the admin console — which is to say, none.
 *
 * The console draws its own dark sidebar (`AdminShell`), so it must not also get
 * the site header and footer the `(app)` group adds. That is the whole reason it
 * lives in its own route group: `(admin)` is a grouping folder, so the URLs are
 * unchanged — `(admin)/admin/page.tsx` is still `/admin`.
 *
 * The `<main>` element belongs here rather than in the pages, so each admin route
 * is just its content and the skip-link target exists exactly once per page.
 */
export default function AdminLayout({ children }: LayoutProps<"/">) {
  return (
    <main id="main" className="flex flex-1 flex-col">
      {children}
    </main>
  );
}
