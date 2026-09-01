import type { MetadataRoute } from "next";

/**
 * The web app manifest, served at `/manifest.webmanifest`.
 *
 * A file convention rather than a static `public/manifest.json`: Next emits the
 * `<link rel="manifest">` tag itself, so nothing in `layout.tsx` has to name the
 * path, and it gets the correct `application/manifest+json` content type — which
 * a `.json` file in `public/` would not, and some browsers reject.
 *
 * The path this is served at ends in `.webmanifest`, which `proxy.ts` excludes
 * from its matcher. That matters: the auth gate redirects a signed-out visitor
 * to `/welcome`, and a manifest request answered with a redirect to an HTML page
 * is discarded — the app would silently stop being installable.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "JobHub — Jobs & Internships",
    /* Home-screen labels are truncated around 12 characters on both Android and
       iOS, so the short name is the bare brand rather than a clipped tagline. */
    short_name: "JobHub",
    description:
      "JobHub gathers jobs and internships from public channels and lists them by role, batch and location, so you can see what is actually open to you in one place.",

    /* `/` and not `/welcome`: the proxy sends a signed-out visitor from `/` to
       the landing page and a signed-in one to the feed, so this one entry point
       resolves to the right page for whoever opened the app. Hardcoding
       `/welcome` would show the marketing page to users who are already in.

       `id` pins the app's identity independently of `start_url`. Without it the
       browser derives identity from the URL, and any later change to `start_url`
       would register as a *different* app, leaving the installed copy orphaned. */
    id: "/",
    start_url: "/",
    /* Every route is in scope; nothing here links out to a sibling path that
       should open in the browser instead. */
    scope: "/",

    display: "standalone",
    orientation: "portrait",

    /* Matches `--color-background` in globals.css — the colour the splash screen
       is painted before first paint, so a mismatch shows as a flash. */
    background_color: "#fafaf9",
    /* Matches `--color-surface`, the sticky header's fill, so the OS title bar
       continues the header rather than butting a different colour against it.
       The site is light-only (no `prefers-color-scheme` rules in globals.css),
       so one value is honest here. */
    theme_color: "#ffffff",

    icons: [
      /* `any` and `maskable` are separate entries on purpose. A single icon
         marked as both is a compromise: Android crops maskable icons, so the
         artwork must be inset for it, and that inset icon then looks too small
         everywhere else. These come from `scripts/logo-assets.mjs`, which insets
         the maskable one further for exactly this reason. */
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
