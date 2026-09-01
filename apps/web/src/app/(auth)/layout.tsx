/**
 * Chrome for the authentication pages.
 *
 * Deliberately bare: no site header and no footer. A visitor here has not signed
 * in yet, so a nav bar linking to feed sections that are not on the page would be
 * dead weight at best and a set of dead ends at worst. What is left is one
 * centred column, which is also what keeps these pages free of horizontal
 * overflow on a narrow screen.
 *
 * `(auth)` is a grouping folder, so it contributes nothing to the URL —
 * `(auth)/sign-in/[[...sign-in]]/page.tsx` serves `/sign-in`.
 */
export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main
      id="main"
      className="flex flex-1 flex-col items-center justify-center px-4 py-12 sm:px-6 sm:py-16"
    >
      {children}
    </main>
  );
}
