"use client";

import { useEffect } from "react";

/**
 * Registers `public/sw.js` once the page is interactive.
 *
 * Renders nothing. It is a component rather than an inline script so it lands in
 * the client bundle Next already ships, with no extra <script> tag and no
 * change to the document `layout.tsx` produces.
 *
 * Registration is deferred to the `load` event: a service worker install
 * competes with the page's own requests for bandwidth, and doing it during the
 * initial load is a measurable delay on a first visit for no benefit — the
 * worker cannot serve the page that registers it anyway.
 *
 * Development is skipped. `next dev` serves unhashed assets from the same
 * `/_next/static/` prefix the worker caches, so a registered worker would serve
 * yesterday's chunk after an edit and look like a broken hot reload.
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      /* Failure is intentionally swallowed to a warning: an unregistered worker
         costs installability, not the app. Throwing here — or leaving the
         rejection unhandled — would turn a private-mode browser, where the API
         exists but registration is refused, into a console error on every load
         of a working page. */
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
        console.warn("[pwa] service worker registration failed", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
