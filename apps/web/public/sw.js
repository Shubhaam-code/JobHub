/**
 * Service worker for the installed app.
 *
 * Deliberately minimal, and the reasoning matters more than the code: this app
 * is authenticated and its content is live. Almost everything a service worker
 * normally caches is something this app must not cache.
 *
 *   - HTML navigations run through `proxy.ts`, which decides — per request, from
 *     the Clerk session — whether to serve the page or redirect to `/sign-in`.
 *     A cached page would be served to whoever opens the app next, including a
 *     signed-out visitor, and would show one user's shell to another.
 *   - `/api/*` is per-user data (recommendations, profile, resume) behind a
 *     bearer token. Caching it would leak one account's data into another's.
 *   - Job listings are the product's live feed. A stale one is a wrong one.
 *
 * So this worker caches exactly one class of thing: build-immutable static
 * assets under `/_next/static/`, whose URLs contain a content hash. They cannot
 * go stale — a new build produces new URLs — which makes them the only safe
 * cache-first target here. Everything else falls through to the network
 * untouched, meaning the app behaves online exactly as it did before.
 *
 * That is enough for installability: the install criteria need a manifest, HTTPS
 * and a registered service worker with a fetch handler. They do not require
 * offline content, and inventing an offline mode for a live job feed would be a
 * feature, not PWA support.
 */

/* Bumping this string is what evicts the old cache — `activate` deletes every
   cache whose name is not this one. Tied to the asset contract above, not to the
   app version: it only needs to change if what gets cached changes. */
const CACHE = "jobhub-static-v1";

/* Take over without waiting for every existing tab to close. Paired with
   `clients.claim()` below so a freshly installed worker controls the page that
   registered it, rather than sitting idle until the next navigation. */
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  /* Only GET is cacheable, and only our own origin is ours to reason about.
     Cross-origin requests (Clerk's scripts, Google Fonts, the API on its own
     host) are left entirely alone — they have their own caching rules and their
     own auth, and an opaque response cached here would be a black box. */
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  /* The one safe case: hashed build output. Not `/_next/image`, which is a
     transform endpoint taking arbitrary query strings, and not `/_next/data`,
     which is per-request payload. */
  if (!url.pathname.startsWith("/_next/static/")) return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;

      const response = await fetch(request);

      /* `response.ok` excludes redirects and errors; `basic` excludes opaque
         cross-origin responses that slipped past the origin check via a
         redirect. Only a real, complete same-origin 200 is stored. */
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }

      return response;
    })(),
  );
});
