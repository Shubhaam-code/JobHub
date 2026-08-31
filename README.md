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
│   │   │   ├── middleware   Request logging, 404, error handler
│   │   │   ├── models       Job schema + dedup index
│   │   │   ├── routes       /health, /api/v1 index, /api/v1/jobs
│   │   │   ├── scripts      Telegram login, channel check, listener, backfill, cleanup
│   │   │   └── telegram     Client, channels, listener, backfill, pre-filter,
│   │   │                    classifier, text safety, validator, ingestion
│   │   └── tests            Vitest suite (no database required)
│   └── web                  Next.js client
│       └── src
│           ├── app          App Router layout, landing page, /jobs/[id]
│           ├── components   Header, footer, opportunity explorer/card/search
│           └── lib          API client, Socket.IO client, view helpers
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

The landing page lists the postings the API has ingested, and updates live over Socket.IO as
new ones arrive.

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
stored total. Safe to re-run: duplicates are skipped by the dedup index.

```bash
npm run jobs:cleanup --workspace @jia/api -- --dry-run
```

Re-classifies the postings already in MongoDB, reporting which ones the current classifier
considers genuine. Drop `--dry-run` to actually remove the non-jobs and refresh extracted
fields; add `--configured-only` to restrict it to channels currently in `TELEGRAM_CHANNELS`.
Both scripts require `GEMINI_API_KEY`.

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

| Method | Path                    | Purpose                                              |
| ------ | ----------------------- | ---------------------------------------------------- |
| `GET`  | `/health`               | Liveness. Always `200` when the process can respond. |
| `GET`  | `/health/ready`         | Readiness. `503` until MongoDB is connected.         |
| `GET`  | `/api/v1`               | Service index listing the available endpoints.       |
| `GET`  | `/api/v1/jobs`          | Postings, newest `postedAt` first, paginated.        |
| `GET`  | `/api/v1/jobs/channels` | Source channels that currently have postings.        |
| `GET`  | `/api/v1/jobs/:id`      | One posting by MongoDB id.                           |

`/api/v1/jobs` accepts `page` (default `1`), `limit` (default `20`, max `100`), `search`
(matches company or role), `batch`, `type` (`internship` or `full-time`, derived from the role
text), and `channel` (source channel username, with or without a leading `@`). Invalid values
return `400`.

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

| Variable            | Default                                    | Notes                                    |
| ------------------- | ------------------------------------------ | ---------------------------------------- |
| `NODE_ENV`          | `development`                              | `development` \| `test` \| `production`  |
| `PORT`              | `4000`                                     | 1–65535                                  |
| `MONGODB_URI`       | `mongodb://127.0.0.1:27017/job_aggregator` | `mongodb://` or `mongodb+srv://`         |
| `CORS_ORIGINS`      | `http://localhost:3000`                    | Comma-separated origins                  |
| `LOG_LEVEL`         | `info`                                     | `error` \| `warn` \| `info` \| `debug`   |
| `TELEGRAM_API_ID`   | _(unset)_                                  | Numeric api_id from my.telegram.org      |
| `TELEGRAM_API_HASH` | _(unset)_                                  | 32-char api_hash from my.telegram.org    |
| `TELEGRAM_SESSION`  | _(unset)_                                  | Secret. From `npm run telegram:login`    |
| `TELEGRAM_CHANNELS` | `jobs_and_internships_updates`             | Comma-separated public channel usernames |
| `GEMINI_API_KEY`    | _(unset)_                                  | Secret. From aistudio.google.com/apikey  |
| `GEMINI_MODEL`      | `gemini-3.7-flash`                         | Model used for classification            |
| `LLM_TIMEOUT_MS`    | `20000`                                    | Per-attempt ceiling, 1000–120000         |

Validated by Zod at startup — the process exits with a readable message on bad config. The
three `TELEGRAM_*` credentials are optional: without all of them the API still boots and
serves whatever is already in MongoDB, it just does not start the listener. Without
`GEMINI_API_KEY` the listener starts but classifies nothing, so no posting is stored.

`TELEGRAM_CHANNELS` is a comma-separated list, so adding a channel needs no code change. A
leading `@`, surrounding whitespace and duplicates are all handled:

```
TELEGRAM_CHANNELS=@jobs_and_internships_updates,@jobsvillaa,@internfreak
```

Never commit `apps/api/.env`. It is git-ignored, and `TELEGRAM_SESSION` grants full access to
the Telegram account it was generated from.

**`apps/web/.env.local`**

| Variable                 | Default                 | Notes                                    |
| ------------------------ | ----------------------- | ---------------------------------------- |
| `NEXT_PUBLIC_API_URL`    | `http://localhost:4000` | Inlined into the browser bundle          |
| `NEXT_PUBLIC_SOCKET_URL` | `NEXT_PUBLIC_API_URL`   | Only needed if Socket.IO is served apart |

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

## Not implemented yet

- Authentication
- Admin dashboard
