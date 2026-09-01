import type { Metadata, Viewport } from "next";
import { Lexend, Source_Sans_3 } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import "./globals.css";

import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import { CLERK_ENABLED } from "@/lib/clerk";

/* "Corporate Trust" pairing from ui-ux-pro-max. Lexend is designed for reading
   proficiency, which suits a page whose job is scanning listings quickly. */
const lexend = Lexend({
  variable: "--font-lexend",
  subsets: ["latin"],
  display: "swap",
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  /* A template rather than a bare string, so every page that names itself keeps
     the brand in the tab: "Explore Jobs — JobHub". `default` is what routes that
     set no title of their own get, and it is the bare brand: the tab is not the
     place for a tagline. */
  title: {
    default: "JobHub",
    template: "%s — JobHub",
  },
  description:
    "JobFeed gathers jobs and internships from public channels and lists them by role, batch and location, so you can see what is actually open to you in one place.",
  /* No `icons` key: `app/icon.png` and `app/apple-icon.png` are file conventions
     Next resolves on its own, and it fingerprints them for cache-busting and
     fills in the right `type`/`sizes` — none of which a hand-written path gets.
     Declaring both would emit two competing <link rel="icon"> tags.

     Those two files are square crops of the icon-only source, built by
     `scripts/logo-assets.mjs`. The wide lockup this used to point at was the
     wrong shape for a 16px tab: browsers letterbox it and the wordmark smears.

     No `manifest` key either, for the same reason: `app/manifest.ts` is a file
     convention, and Next emits the <link rel="manifest"> tag from it. */

  /* iOS does not read `display: standalone` from the manifest — Safari decides
     whether an added-to-home-screen app opens in a browser chrome or without it
     from these meta tags alone. Without them the icon on an iPhone home screen
     opens a normal Safari tab, which is the whole thing users notice.

     `default` status bar rather than `black-translucent`: the translucent style
     draws the page *under* the status bar, and the sticky header in
     `site-header.tsx` has no top inset to compensate, so the nav would sit
     beneath the clock. */
  appleWebApp: {
    capable: true,
    title: "JobHub",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /* Tints the browser and OS chrome around the app. Matches `--color-surface`,
     the header's fill, and the manifest's `theme_color` — the manifest value
     covers the installed app, this one covers an ordinary tab, and they agree so
     the two contexts look the same. */
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const htmlClasses = [lexend.variable, sourceSans.variable, "h-full", "antialiased"].join(" ");
  
  return (
    <html lang="en" className={htmlClasses} suppressHydrationWarning>
      {/* Header and footer used to be assembled here, which gave them to every
          route — including the sign-in pages, where the nav points at feed
          sections that are not on the page. They now live in `(app)/layout.tsx`,
          so this file is down to what genuinely is global: the document, the
          fonts and the Clerk session.

          `ClerkProvider` goes inside <body>, not around <html>: it renders a
          Suspense boundary and its own scripts, and hoisting it above <html>
          leaves Next unable to stream the document shell.

          Rendered conditionally so the rest of the project still runs without
          Clerk keys in development. The flag is a build-time constant Next
          inlines identically on the server and in the browser, so both sides
          agree on the shape of this tree and hydration is unaffected. Production
          never takes the `false` branch — `CLERK_ENABLED` is true there
          unconditionally, and `proxy.ts` refuses to serve a production
          deployment whose keys are missing. */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        {/* Outside the Clerk conditional and rendering null, so it registers the
            worker on both branches and adds no element to the flex column. */}
        <ServiceWorkerRegistrar />
        {CLERK_ENABLED ? (
          <ClerkProvider
            dynamic
            /* Signing out lands on the landing page — the same place the proxy
               would send them next, so there is one navigation instead of two,
               and it is a page a signed-out visitor is allowed to read. Set on
               the provider so the avatar menu and any sign-out control agree
               without repeating themselves. */
            afterSignOutUrl="/welcome"
            /* Enough to stop Clerk's widget looking bolted on: it inherits the
               brand colour, the corner radius and the body face from the same
               tokens as everything else. Only variables, no element overrides —
               restyling Clerk's internals would break on their next release. */
            appearance={{
              variables: {
                colorPrimary: "#d24200",
                colorPrimaryForeground: "#ffffff",
                colorForeground: "#1c1917",
                colorMutedForeground: "#57534e",
                colorBorder: "#e7e5e4",
                colorRing: "#d24200",
                borderRadius: "0.625rem",
                fontFamily: "var(--font-source-sans)",
              },
            }}
          >
            {children}
          </ClerkProvider>
        ) : (
          children
        )}
      </body>
    </html>
  );
}

