# Job & Internship Aggregator

Aggregates job and internship postings into one place.

> **Status: Telegram ingestion is live.** Public Telegram channels are read over MTProto,
> classified by an LLM into structured postings, deduplicated into MongoDB, served over REST,
> pushed to the browser over Socket.IO, and rendered by the Next.js client.

## Stack

| Layer    | Choice                                                     |
| -------- | ---------------------------------------------------------- |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind v4 |
| Backend  | Node.js, Express 5, TypeScript                             |
| Database | MongoDB via Mongoose 9                                     |
| Ingest   | Telegram MTProto via GramJS (`telegram`)                   |
| Classify | Google Gemini via `@google/genai` (structured JSON output) |
| Realtime | Socket.IO 4                                                |
| Auth     | Clerk for users; own HMAC token + Mongo role for admins    |
| Tooling  | npm workspaces, ESLint 9, Prettier, Vitest 4               |

## Layout

```
.
├── apps
│   ├── api                  Express + MongoDB + Telegram service
│   │   ├── src
│   │   │   ├── app.ts       Express app factory (no port binding)
│   │   │   ├── index.ts     Server startup, listener boot, graceful shutdown
│   │   │   ├── config       Env validation, Mongo connection
│   │   │   ├── lib          Logger, HttpError, Socket.IO server
│   │   │   ├── llm          Gemini client wrapper (structured JSON, never throws)
│   │   │   ├── middleware   Request logging, auth guards, 404, error handler
│   │   │   ├── models       Job, user and Telegram channel schemas
│   │   │   ├── routes       /health, /api/v1/jobs, /api/auth, /api/admin
│   │   │   ├── scripts      Telegram login, channel check, listener, backfill,
│   │   │   │                cleanup, user create
│   │   │   └── telegram     Client, channels, channel registry, listener,
│   │   │                    backfill, pre-filter, classifier, text safety,
│   │   │                    validator, ingestion
│   │   └── tests            Vitest suite (no database required)
│   └── web                  Next.js client
│       └── src
│           ├── app          App Router shell, (auth) landing + Clerk pages,
│           │                (app) feed, /jobs/[id], /admin, /profile
│           ├── components   Header, footer, opportunity explorer/card/search,
│           │                admin login + dashboard, Clerk account control
│           ├── lib          Public API client, admin API client, Socket.IO
│           │                client, Clerk config, view helpers
│           └── proxy.ts     Server-side auth gate (Next 16 renamed
│                            middleware.ts to proxy.ts)
└── package.json             Workspace root + task scripts
```

## Prerequisites

- Node.js **>= 20.19** (developed on 24.19)
- npm **>= 10**
- MongoDB — optional for boot, required for anything that stores data. Use a local
  `mongod` on `27017` or a MongoDB Atlas connection string.

## Setup

```bash
npm install
```

Copy the example env files. The defaults work as-is for local development, so this is only
needed when you want to change a value:

```bash
cp apps/api/.env.example apps/api/.env && cp apps/web/.env.example apps/web/.env.local
```

Start both apps together:

```bash
npm run dev
```

- Web: http://localhost:3000
- API: http://localhost:4000

`http://localhost:3000` opens the sign-in landing page. Choosing "Continue as User" needs Clerk
keys in `apps/web/.env.local`; without them the gate is skipped and the feed is served directly,
so nothing else here requires setting them up. See [Authentication](#authentication).

The feed lists the postings the API has ingested, and updates live over Socket.IO as new ones
arrive.

### Telegram access

The API only reads public channels — it never posts, and never joins or leaves anything. Run
these from the repository root:

```bash
npm run telegram:login --workspace @jia/api
```

Prints a session string for `TELEGRAM_SESSION`. Treat that string like a password: it is a
full account credential.

```bash
npm run telegram:channel-check --workspace @jia/api
```

Read-only access test — resolves every channel in `TELEGRAM_CHANNELS` and prints metadata for
the latest few messages of each. Stores nothing, and needs no Gemini key.

```bash
npm run telegram:backfill --workspace @jia/api
```

Runs the 7-day backfill for every configured channel and prints per-channel counters plus the
stored total. Safe to re-run: duplicates are skipped by the dedup index. It only fills the
queue — the worker classifies what it enqueued, so this returns long before the LLM is finished.

```bash
npm run queue:status --workspace @jia/api
```

Read-only report on the ingest queue: a count per status, how many messages are claimable right
now, the worker's settings, and the next scheduled retries with their due times. Add `--failed`
to list the dead-letter rows. Needs no Gemini key.

```bash
npm run jobs:cleanup --workspace @jia/api -- --dry-run
```

Re-classifies the postings already in MongoDB, reporting which ones the current classifier
considers genuine. Drop `--dry-run` to actually remove the non-jobs and refresh extracted
fields; add `--configured-only` to restrict it to channels currently in `TELEGRAM_CHANNELS`.
It also re-runs the deterministic sanitizer over each stored post, which is what repairs an
`applyUrl` on a document written before extraction moved out of the LLM. `telegram:backfill`
and `jobs:cleanup` both require `GEMINI_API_KEY`.

## Scripts

Run from the repository root.

| Script                 | Effect                                          |
| ---------------------- | ----------------------------------------------- |
| `npm run dev`          | API and web together, colour-tagged output      |
| `npm run dev:api`      | API only (`tsx watch`)                          |
| `npm run dev:web`      | Web only (`next dev`)                           |
| `npm run build`        | Compile the API, then build the web app         |
| `npm test`             | Vitest suite for the API                        |
| `npm run lint`         | ESLint across both workspaces                   |
| `npm run typecheck`    | `tsc --noEmit` across both workspaces           |
| `npm run format`       | Write Prettier formatting                       |
| `npm run format:check` | Verify Prettier formatting                      |
| `npm run start:api`    | Run the compiled API from `dist/` (build first) |
| `npm run start:web`    | Run the production web server (build first)     |

## API endpoints

| Method  | Path                      | Purpose                                              |
| ------- | ------------------------- | ---------------------------------------------------- |
| `GET`   | `/health`                 | Liveness. Always `200` when the process can respond. |
| `GET`   | `/health/ready`           | Readiness. `503` until MongoDB is connected.         |
| `GET`   | `/api/v1`                 | Service index listing the available endpoints.       |
| `GET`   | `/api/v1/jobs`            | Postings, newest `postedAt` first, paginated.        |
| `GET`   | `/api/v1/jobs/:id`        | One posting by MongoDB id.                           |
| `POST`  | `/api/auth/login`         | Exchange email + password for a bearer token.        |
| `GET`   | `/api/auth/me`            | The caller's `{ id, email, role }`. Needs a token.   |
| `GET`   | `/api/admin/channels`     | **ADMIN.** Every channel with its statistics.        |
| `GET`   | `/api/admin/stats`        | **ADMIN.** Fleet-wide totals and ingestion health.   |
| `PATCH` | `/api/admin/channels/:id` | **ADMIN.** `{ status: "active" \| "paused" }`.       |

`/api/v1/jobs` accepts `page` (default `1`), `limit` (default `20`, max `100`), `search`
(matches company or role), `batch`, and `type` (`internship` or `full-time`, derived from the
role text). Invalid values return `400`.

The public job payload carries **no Telegram provenance** — no channel name, channel id, message
id or raw post. It is `id`, `company`, `role`, `batch`, `applyUrl`, `location`,
`employmentType`, `description`, `postedAt`, `createdAt`, `updatedAt`, where `description` is the
post with channel promotion stripped server-side. There is no public channel list and no
`channel` filter: which channels feed the product is readable only through the admin API.

Socket.IO is served on the same port. Clients receive a `job:new` event carrying the same
posting shape whenever a new posting is actually inserted.

Unknown routes return `404` using the shared error envelope:

```json
{ "error": { "message": "Route not found: GET /nope", "statusCode": 404 } }
```

Stack traces are included outside production and omitted in it.

### MongoDB is not required to start

`connectDatabase()` logs a failure and continues rather than crashing, so you can work on the
API without a local `mongod`. `/health` reports the real connection state and `/health/ready`
returns `503` while it is down. Add a readiness gate in front of anything that needs the
database.

## Environment variables

**`apps/api/.env`**

| Variable                      | Default                                    | Notes                                    |
| ----------------------------- | ------------------------------------------ | ---------------------------------------- |
| `NODE_ENV`                    | `development`                              | `development` \| `test` \| `production`  |
| `PORT`                        | `4000`                                     | 1–65535                                  |
| `MONGODB_URI`                 | `mongodb://127.0.0.1:27017/job_aggregator` | `mongodb://` or `mongodb+srv://`         |
| `CORS_ORIGINS`                | `http://localhost:3000`                    | Comma-separated origins                  |
| `LOG_LEVEL`                   | `info`                                     | `error` \| `warn` \| `info` \| `debug`   |
| `TELEGRAM_API_ID`             | _(unset)_                                  | Numeric api_id from my.telegram.org      |
| `TELEGRAM_API_HASH`           | _(unset)_                                  | 32-char api_hash from my.telegram.org    |
| `TELEGRAM_SESSION`            | _(unset)_                                  | Secret. From `npm run telegram:login`    |
| `TELEGRAM_CHANNELS`           | `jobs_and_internships_updates`             | Comma-separated public channel usernames |
| `GEMINI_API_KEY`              | _(unset)_                                  | Secret. From aistudio.google.com/apikey  |
| `GEMINI_MODEL`                | `gemini-3.7-flash`                         | Model used for classification            |
| `GROQ_API_KEY`                | _(unset)_                                  | Secret. From console.groq.com/keys       |
| `GROQ_MODEL`                  | `openai/gpt-oss-20b`                       | Model used for resume parsing            |
| `LLM_TIMEOUT_MS`              | `20000`                                    | Per-attempt ceiling, 1000–120000         |
| `LLM_MAX_REQUESTS_PER_MINUTE` | `10`                                       | Rolling-minute ceiling, process-wide     |
| `LLM_CONCURRENCY`             | `1`                                        | In-flight LLM calls. 1 = serial          |
| `QUEUE_WORKER_ENABLED`        | `true`                                     | `false` queues without classifying       |
| `QUEUE_POLL_INTERVAL_MS`      | `2000`                                     | Idle poll interval, 200–600000           |
| `QUEUE_MAX_ATTEMPTS`          | `6`                                        | Attempts before dead-lettering, 1–50     |
| `QUEUE_RETRY_BASE_MS`         | `5000`                                     | First backoff step; doubles per attempt  |
| `QUEUE_RETRY_MAX_MS`          | `600000`                                   | Backoff ceiling                          |
| `QUEUE_STALE_CLAIM_MS`        | `300000`                                   | Age at which a claim counts as abandoned |
| `AUTH_SECRET`                 | _(unset)_                                  | Secret. Signs bearer tokens, min 16 char |
| `AUTH_TOKEN_TTL_HOURS`        | `12`                                       | Token lifetime, 1–720                    |
| `ADMIN_EMAIL`                 | _(unset)_                                  | Seeds the first ADMIN at startup         |
| `ADMIN_PASSWORD`              | _(unset)_                                  | Secret. Min 8 chars. Used with the above |

Validated by Zod at startup — the process exits with a readable message on bad config. The
three `TELEGRAM_*` credentials are optional: without all of them the API still boots and
serves whatever is already in MongoDB, it just does not start the listener. Without
`GEMINI_API_KEY` the listener starts and messages still queue up durably; nothing is
classified until a key is present, and nothing is lost in the meantime.

Resume parsing uses a different provider from classification: `GROQ_API_KEY` is the only key on
that path, with no fallback. Without it an upload answers with the resume-parsing error state and
the user sets their preferences by hand instead. It is read on the server only and never reaches
the browser. `GROQ_MODEL` must support strict JSON-schema structured outputs.

The `LLM_*` throttles exist so the common case is never hitting a 429 at all — set them to the
quota of your key. The `QUEUE_*` settings govern what happens when one arrives anyway; see
[How ingestion works](#how-ingestion-works).

`AUTH_SECRET` is also optional outside production: when unset, a fixed insecure development key is
used and a warning is logged, so tokens survive a `tsx watch` restart and local work needs no
configuration. In production an unset `AUTH_SECRET` is fatal — the process refuses to boot rather
than sign admin tokens with a guessable key. Changing it is the intended way to revoke every
outstanding token at once. `ADMIN_EMAIL`/`ADMIN_PASSWORD` never rewrite an existing account's
password — a matching account is only promoted to `ADMIN` if it is not one already — so leaving
them set does not undo a password change.

`TELEGRAM_CHANNELS` is a comma-separated list, so adding a channel needs no code change. A
leading `@`, surrounding whitespace and duplicates are all handled:

```
TELEGRAM_CHANNELS=@jobs_and_internships_updates,@jobsvillaa,@internfreak
```

Never commit `apps/api/.env`. It is git-ignored, and `TELEGRAM_SESSION` grants full access to
the Telegram account it was generated from.

**`apps/web/.env.local`**

| Variable                                          | Default                 | Notes                                      |
| ------------------------------------------------- | ----------------------- | ------------------------------------------ |
| `NEXT_PUBLIC_API_URL`                             | `http://localhost:4000` | Inlined into the browser bundle            |
| `NEXT_PUBLIC_SOCKET_URL`                          | `NEXT_PUBLIC_API_URL`   | Only needed if Socket.IO is served apart   |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`               | _(unset)_               | Public by design. Required to build        |
| `CLERK_SECRET_KEY`                                | _(unset)_               | Secret, **server only**. Required to build |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`                   | `/sign-in`              | Our page, not Clerk's Account Portal       |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL`                   | `/sign-up`              | Our page, not Clerk's Account Portal       |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | `/`                     | Where sign-in lands by default             |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | `/`                     | Where sign-up lands by default             |

The two Clerk keys are optional in development and mandatory for a production build; see
[Authentication](#authentication) for what happens without them.

## Known version constraints

- **ESLint is pinned to `^9`, not 10.** `eslint-config-next@16.3.3` bundles an
  `eslint-plugin-react` that calls a context API removed in ESLint 10, which crashes
  `next lint` with `contextOrFilename.getFilename is not a function`. Revisit once
  `eslint-config-next` ships ESLint 10 support.
- **TypeScript is pinned to `^5`, not 7.** `typescript-eslint@8` declares
  `typescript >=4.8.4 <6.1.0`.

## How ingestion works

On startup, when Telegram credentials are present, the API resolves each channel in
`TELEGRAM_CHANNELS`, registers the live `NewMessage` handler, and only then backfills. Both
paths go through the same pipeline: pre-filter → classify → ground → validate → insert.

- **Backfill** walks each channel newest-first and stops at the first message older than 7
  days, with a hard cap of 1000 messages walked per channel. It ingests oldest-first so
  ordering matches the live path.
- **Pre-filtering** is local and deliberately permissive: a post is skipped before any LLM call
  only when it is empty, too short with no work-related word, or a pure promotion/greeting CTA.
  Anything ambiguous goes to the LLM, which is the actual classifier.
- **Classification** is one Gemini call per post, constrained to a JSON schema, returning
  `isJob` plus `company`, `role`, `batch`, `applyUrl`, `location` and `employmentType`. There is
  no free-form parsing, and no channel-specific logic anywhere: adding a channel to
  `TELEGRAM_CHANNELS` is the whole change. A missing key, a provider error, a timeout or
  unusable output are logged as a skip reason — never a crash, and never a stored value.
- **Grounding** re-checks every returned field against the original post, so a value the post
  never contained cannot be stored. Apply URLs must be `http(s)`, and chat links (`t.me`,
  `telegram.me`, `telegram.dog`, `wa.me`, `chat.whatsapp.com`) are never treated as application
  URLs — channels link to themselves and to partner channels constantly. Telegram handles and
  "join now / DM / collab / promotion" CTAs are likewise never stored as a company or role.
- **Validation** runs after the LLM and is the final authority: a posting needs `isJob`, a
  company or a role, and a safe non-chat `applyUrl` if it has one at all. A missing batch,
  apply URL, location or employment type is fine and does not disqualify a genuine posting.
- **Deduplication** is a unique index on `(telegramChannel, telegramMessageId)`. A duplicate
  key is treated as success, so re-running the backfill inserts nothing and broadcasts
  nothing. The channel is part of the key, so the same message id in two channels is two
  distinct postings.
- **Provenance** is per posting: `telegramChannel` holds the real source channel and
  `telegramMessageUrl` is built from it, so a posting always links back to the channel it came
  from.

Rate limits are surfaced, never silently retried: `floodSleepThreshold` is `0`, so a
`FLOOD_WAIT` is logged with its wait time and the message is skipped.

## Authentication

Two independent systems. They share no code, no tokens and no user records, which is the point:
signing in through one can never grant what the other guards.

|                     | Normal users                                 | Administrators                                          |
| ------------------- | -------------------------------------------- | ------------------------------------------------------- |
| Provider            | Clerk (`@clerk/nextjs`)                      | This project's own API                                  |
| Entry point         | `/welcome` → "Continue as User" → `/sign-in` | `/welcome` → "Admin Login" → `/admin`                   |
| Credential          | Clerk session cookie                         | HMAC bearer token from `POST /api/auth/login`           |
| Enforced by         | `apps/web/src/proxy.ts`                      | `requireAdmin`, mounted on the admin router itself      |
| Accounts created by | Self-service sign-up                         | Operator only (see [Admin dashboard](#admin-dashboard)) |

`/welcome` is the first page a signed-out visitor sees; every other route redirects there, deep
links included (`/jobs/abc` → `/welcome?redirect_url=/jobs/abc`, and back again after sign-in).
An already-signed-in visitor is redirected off `/welcome` to the feed, so nobody sees the landing
page twice. `redirect_url` is reduced to a same-origin path before use — it arrives in a query
string, so an unchecked value would make our own sign-in flow an open redirect.

**A Clerk user is never an administrator.** Nothing links a Clerk identity to a Mongo `User`
record, and `ADMIN` is only ever read from that record, so `/api/admin/*` answers `403` to a
signed-in Clerk user exactly as it does to an anonymous one. `/admin` is deliberately outside the
Clerk gate: it authenticates on its own, which keeps existing admin sessions working and avoids a
second user-authentication system.

Clerk keys go in `apps/web/.env.local` (see [`apps/web/.env.example`](apps/web/.env.example)):

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
```

`CLERK_SECRET_KEY` is server-only. Renaming it to `NEXT_PUBLIC_*` or importing it into a component
would inline it into the browser bundle and publish it; only `src/proxy.ts` reads it.

Without the keys, `npm run dev:web` still serves the feed and the admin dashboard — the gate is
skipped so the rest of the project stays runnable — and `/welcome` says what is missing. A
production build **fails on purpose** rather than ship an app whose gate does nothing, so
`npm run build:web` needs both keys present.

## Admin dashboard

`/admin` in the web app lists every Telegram channel the system knows about with its ingestion
statistics, and lets an administrator pause or resume one. The channel list is derived from the
registry, `TELEGRAM_CHANNELS` and stored ingestion data — nothing is hardcoded, so adding a
channel to the env list is still the whole change.

**Pausing stops future ingestion and nothing else.** Existing jobs, queued messages and
statistics are all left in place, so resuming continues from where the channel left off. A
paused channel is also skipped by the startup backfill, and a restart never un-pauses it.

Access is enforced **on the API**, not by the page: `requireAdmin` is applied to the admin router
itself, so every endpoint under `/api/admin` returns `401` without a valid token and `403` for a
normal `USER` — including a `USER` holding a correctly-signed token that claims `ADMIN`, because
the role is read from the database on every request. That is why linking the page from `/welcome`
costs nothing: the link leads to a sign-in form, not to anything an anonymous visitor can read.
The page is deliberately **not** linked from the site header, so a normal signed-in user is never
shown a door that is not theirs — reaching it takes the landing page or the `/admin` URL.

There is no signup. Accounts are created by the operator, either by setting `ADMIN_EMAIL` and
`ADMIN_PASSWORD` (seeded idempotently at startup) or with:

```bash
npm run user:create --workspace @jia/api -- --email admin@local --password secret --role ADMIN
```

Re-running it for an existing email resets that account's password and role, which is also how a
forgotten admin password is recovered. Drop `--role` to create the normal `USER` that proves the
`403`.

## Not implemented yet

- Password reset and account self-service for **admin** accounts (they are operator-provisioned;
  normal user accounts get all of this from Clerk)
