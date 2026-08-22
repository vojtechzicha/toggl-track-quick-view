# toggl-track-quick-view — Development Notes

A single-screen quick view for tracking a work day against a weekly target,
reading from Toggl Track or from its own MongoDB store. Next.js App Router,
deployed on Vercel at track.zicha.dev.

**`README.md` is the product documentation** and it is thorough (800+ lines):
the targets model, Short Friday, billing tags, timesheets and PDF exports,
workspaces, rate limits. Read it before changing behaviour — most of what looks
like an odd special case is specified there. This file covers how to RUN and
CONFIGURE the thing, which the README only summarises.

Other docs: `docs/ENVIRONMENT.md` (configuration, in full),
`docs/pdf-signing-v2.md`, `docs/standalone/phase-*.md` (how standalone mode was
built).

## Environment configuration

Config is **generated from committed templates**, never copied between machines.
Full guide in `docs/ENVIRONMENT.md`.

- `scripts/env-spec.mjs` is the single source of truth: every variable the code
  reads, its description, format checks, and the
  **cross-variable rules**, which are the point of the file. This app has no
  variable it cannot start without — with an empty environment it runs as a
  bring-your-own-token dashboard — so what needs guarding is combinations, not
  individual values. Plain `.mjs`, not a `lib/*.ts`, because `pnpm env:check`
  must run under bare Node in the Vercel build before anything is compiled.
- `DEPLOYMENT_TOPOLOGY` in that file is the one place that encodes OUR
  deployment rather than the app: which variables track.zicha.dev and its
  previews must have. Nothing in it is an application requirement — an empty
  environment is a supported mode — so a fork empties it and every requirement
  relaxes, while format and contradiction checks stay.
- `.env.tpl` → `.env` (local) and `.env.prod.tpl` → `.env.prod` (production
  reference) via `pnpm env:pull` / `env:pull:prod`, which run `op inject`
  against 1Password vault `Development`, items `toggl-track-quick-view-dev`,
  `-preview` and `-prod`. The vault is SHARED by every project on the machine —
  it is an access boundary, not a namespace, so the ITEM carries the project and
  the environment. Only real secrets are `op://` refs; everything else is a
  literal so a template diff shows actual config changes. Both generated files
  are gitignored.
- `op inject` resolves EVERY `op://` in the file, comments included — so a
  commented-out reference breaks the pull. Comments name paths without the
  scheme (`Development/toggl-track-quick-view-prod/MONGODB_URI`).
- **Adding a variable**: spec + both templates in the same commit, then the
  value into 1Password and Vercel by hand. `pnpm env:check` in `vercel-build`
  fails the PR's own preview deployment when the Vercel side is forgotten.
- Preview has **no committed template** — Vercel holds it and the `-preview`
  item mirrors it. Mark a preview-only variable `appliesTo: ['preview']`.
- A Sensitive variable in Vercel can never be read back, so 1Password is where
  a secret is KEPT and Vercel only where it runs. When a value is missing, the
  convention is a field holding the literal `replaceMe` — a blank custom field
  is invisible in the 1Password UI, and `validateEnv` rejects `replaceMe`, so
  the gap is loud rather than silently shipped.

### The combinations that matter

`MONGODB_URI` and `APP_MODE` together decide **what the deployment is**:

| `MONGODB_URI` | `APP_MODE` | Result |
| --- | --- | --- |
| unset | — | Toggl mode, no sync |
| set | unset | **Standalone mode** — own store, Toggl never contacted |
| set | `toggl` | Toggl mode + settings sync |

`APP_MODE=toggl` is required in production for that reason: dropping the row
turns the live dashboard into an empty standalone store, and it would look like
a successful deploy. `MONGODB_URI` without `APP_PASSWORD` is an error (those
routes write and refuse to unauthenticated). `TOGGL_API_TOKEN` without
`APP_PASSWORD` is a warning, not an error — a deliberately public dashboard is a
legitimate choice, but it should never pass unremarked.

## Database

MongoDB, driver only — no ODM. `lib/store/mongo.ts` caches one `MongoClient`
promise on `globalThis` and ensures indexes as part of the initial connect, so
routes can assume they exist. The one real concurrency guarantee (at most one
running timer) is a **partial unique index on `stop: null`**, enforced by the
database rather than by application code.

### Production and preview

Both use one Atlas cluster and **one database user** — the connection strings
are byte-identical. What separates them is `MONGODB_DB` alone: production leaves
it unset and lands in the `toggl-quick-view` default from `lib/store/mongo.ts`,
preview sets `timetrack-quick-view`. `scripts/env-spec.mjs` therefore marks
`MONGODB_DB` **required in preview** — delete that row and a branch deployment
writes over the live synced setup.

Naming trap: the Atlas cluster AND the database named in the connection string
path are both `timetrack-quick-view`, but `client.db()` is always called with an
explicit name, so the path is ignored. Production data is in `toggl-quick-view`.

### Local development

- **Docker Compose `mongo:8` on port 27018**, not Mongo's default, so a MongoDB
  already running on the machine keeps working. No auth: it is bound to
  localhost and holds throwaway data, and the whole point of a local database is
  that it cannot be the production one.
- Data survives `pnpm db:stop` in the `mongodata` volume; `docker compose down -v`
  starts genuinely empty.
- **The default local run uses none of it.** `.env.tpl` ships `APP_PASSWORD`
  blank and `APP_MODE` / `MONGODB_URI` / `MONGODB_DB` commented out, so
  `pnpm dev` is the plain Toggl dashboard — no gate, no database, nothing to
  unlock. `pnpm dev` still starts the container so opting in is one edit.
- Uncomment that block **and** set `APP_PASSWORD` to work on settings sync
  (keep `APP_MODE=toggl`) or standalone mode (drop it). Both halves together:
  those routes write and `env:check` fails on a database without a gate. The
  connection string there is a LITERAL pointing at the local container — the
  default must never be able to reach production.

## Development Commands

```bash
# Environment (1Password -> .env). See docs/ENVIRONMENT.md
pnpm env:pull         # Regenerate .env from .env.tpl
pnpm env:pull:prod    # Write .env.prod from .env.prod.tpl (live prod secrets)
pnpm env:check        # Validate against scripts/env-spec.mjs

# Local development (auto-starts/stops Docker MongoDB)
pnpm dev              # Start MongoDB + Next dev server (DB stops on Ctrl+C)
pnpm devsafe          # Same, minus a stale .next
pnpm db               # Start only MongoDB in background
pnpm db:stop          # Stop MongoDB

# Checks — pure, no network, no database. Run these before proposing a change.
pnpm check            # All of the below (~126k assertions, seconds)
pnpm check:money      # Money/allocation arithmetic
pnpm check:report     # Report content
pnpm check:acceptance # Acceptance content
pnpm check:codes      # Billing-code handling
pnpm check:windows    # Start-window / DST boundaries (reassigns process.env.TZ)
pnpm check:export     # Export scope
pnpm check:fonts      # Font / pdfmake VFS

pnpm build            # next build
pnpm lint             # next lint
```

**Note:** run `pnpm db` first and `pnpm dev` detects the existing container and
leaves it running when you Ctrl+C. If `pnpm dev` started it, Ctrl+C takes it
down.

## Deployment

Vercel, GitHub integration, previews per PR.

- `vercel-build` runs `node scripts/check-env.mjs` before `next build`, so a
  missing or contradictory variable fails the build — and fails the PR's own
  preview deployment first, at review time.
- **`beta.track.zicha.dev` always points at the newest preview.**
  `.github/workflows/preview-alias.yml` reacts to Vercel's `deployment_status`
  events and re-aliases the domain on every successful Preview deployment
  ("last preview wins"); production is ignored. The fixed host exists because
  the password-gate session (`localStorage` `tqv.auth.v1`) and the PWA are both
  per-ORIGIN — a fresh `*-<hash>.vercel.app` per deployment loses both. The
  `VERCEL_TOKEN` repo secret comes from `Development/vercel-zicha-dev-ci`,
  which zicha-travel's equivalent workflow shares.
- **Post-deploy refresh hint**: every build bakes a deterministic build id (git
  commit via `VERCEL_GIT_COMMIT_SHA`, `computeBuildId()` in `next.config.js`)
  into the client bundle AND the server routes; long-lived tabs compare theirs
  against `GET /api/version` and show a toast asking to refresh. It matters more
  here than it looks: with settings sync, a tab on an old build would not know
  newer settings keys and would drop them on its next save. A build with no
  commit falls back to `'unversioned'`, which disables the hint rather than
  misfiring.

## Known considerations

1. **Toggl's rate limit is per ACCOUNT, and local dev shares it with
   production.** The Free plan allows 30 requests/hour. `.env.tpl` sets
   `TOGGL_CACHE_INTERVAL=600` (6/hr) for that reason, which makes the local
   dashboard deliberately stale; production uses 170 (~21/hr). Lower it when
   working on data rather than layout, and remember the two add up. Blanking it
   is not the cheap option — with no shared cache every browser refresh becomes
   its own upstream request.
2. **`TOGGL_CACHE_INTERVAL` hides the per-device "Refresh interval" picker.**
   That is intended, not a bug: with one server-held token every viewer is the
   same user looking at the same data, so one cadence serves them all.
3. **The password gate's signing key is derived from the password itself**
   (`lib/serverAuth.ts`), so rotating `APP_PASSWORD` invalidates every 7-day
   session immediately.
4. **The Toggl API cannot be called from the browser** — CORS is whitelist-only
   and the whitelist call is itself blocked. Everything goes through the
   same-origin proxy at `app/api/toggl/[...path]`.
5. **`.env.local` outranks `.env`** in Next's load order, and the Vercel CLI
   creates one holding a `VERCEL_OIDC_TOKEN` that nothing here reads.
   `pnpm env:check` warns whenever one exists; delete it.
