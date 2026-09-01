import type { NextConfig } from "next";

/* Build-environment diagnostics live here rather than in `lib/clerk.ts`, because
   this file is evaluated once by the main build process — a module under `src/`
   is re-evaluated by every static-generation worker, so a warning there prints
   sixteen times.

   Missing Clerk keys are a warning, not an error: `ClerkProvider` and `proxy.ts`
   both read them from `process.env` on the server per request, so a host that
   only injects them at runtime (Render) produces a working deployment from a
   build that never saw them. `proxy.ts` is what refuses to serve if they are
   still absent when a request arrives. */
if (process.env.NODE_ENV === "production" && !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY?.trim()) {
  console.warn(
    "[clerk] NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is not set in the build environment. " +
      "Continuing — the key is read on the server at request time — but it and " +
      "CLERK_SECRET_KEY must be present in the runtime environment or the app will " +
      "refuse to serve (see apps/web/.env.example).",
  );
}

const nextConfig: NextConfig = {
  /* The recommendations page lives at /recommended-jobs. This keeps the earlier
     /recommended path working, so a bookmark or an open tab on it still lands on
     the page rather than a 404. Not permanent: a 308 would be cached by the
     browser and outlive the rename. */
  async redirects() {
    return [{ source: "/recommended", destination: "/recommended-jobs", permanent: false }];
  },

  /* The service worker is the one file in `public/` that must not be cached.
     Next serves static files with a long `Cache-Control`, and a cached
     `/sw.js` would pin users to the worker from the build they first visited:
     the browser re-fetches it to check for updates, gets the cached copy back,
     sees no byte difference and keeps the old one. A worker that cannot be
     updated cannot be fixed or withdrawn.

     Scoped to this one path — the global caching of every other asset is
     untouched. */
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
