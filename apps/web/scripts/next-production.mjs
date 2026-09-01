/**
 * Runs a `next` subcommand with `NODE_ENV=production` forced, whatever the host
 * environment says.
 *
 * Why this wrapper exists: `next build` crashes if `NODE_ENV=development` is
 * present in the build environment. Compilation succeeds, then prerendering of
 * Next's own `/_global-error` route dies with
 *
 *   TypeError: Cannot read properties of null (reading 'useContext')
 *   Export encountered an error on /_global-error/page: /_global-error
 *
 * because the dev-mode React binding inside Next's minified server chunk for
 * `layout-router` is `null` when it reaches `useContext(LayoutRouterContext)`
 * (vercel/next.js#97046 and the four reports it explains). It is a framework
 * bug, not application code — it reproduces on a bare `create-next-app`, and no
 * amount of editing `global-error.tsx` avoids it, because the route that crashes
 * is Next's built-in one. Only the value `development` triggers it; unset,
 * `production` and `test` all build cleanly.
 *
 * That value reaches us from the host, not from a file: Render injects the
 * service's environment variables into the build container, and `process.env`
 * outranks every `.env` file in Next's lookup order, so nothing inside the repo
 * can override it. Hence forcing it here, in the one process that spawns Next.
 *
 * `start` gets the same treatment: a production build served with
 * `NODE_ENV=development` loads the development React runtime and turns off the
 * `proxy.ts` Clerk guard, so the deployment would come up unauthenticated.
 *
 * Node rather than a `NODE_ENV=production next build` prefix in package.json:
 * that syntax is not valid in cmd.exe, which is what npm hands scripts to on
 * Windows, and this repo is developed there.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* The bin script itself, run with our own `node`, rather than the `next` shim in
   node_modules/.bin — the shim is a shell script on Linux and a .cmd on Windows,
   and spawning either portably needs a shell. */
const nextBin = require.resolve("next/dist/bin/next");

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "production" },
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  /* A signalled child leaves `code` null; report it as a failure rather than
     letting `process.exit(null)` be read as success. */
  process.exit(code ?? (signal ? 1 : 0));
});
