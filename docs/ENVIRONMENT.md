# Environment configuration

`.env` is never committed or copied between machines. Git carries templates
that list every variable the code reads, with literal values for everything that
is not secret. You generate `.env` from a template, by hand or with 1Password.

| File | Committed | What it is |
| --- | --- | --- |
| `.env.tpl` | yes | Local dev config. Literals, plus 1Password references for secrets. |
| `.env.prod.tpl` | yes | Production values. A recoverable copy of what Vercel holds. |
| `scripts/env-spec.mjs` | yes | Every variable, its format check, and the rules for combinations. |
| `.env` | no | Generated from `.env.tpl`. Loaded by Next and by `pnpm env:check`. |
| `.env.prod` | no | Generated on demand. Live production secrets; nothing loads it automatically. |

## Environments

There are three environments and two templates. Vercel preview deployments have
no template: Vercel injects their values, and the 1Password item
`toggl-track-quick-view-preview` keeps a copy. `appliesTo` in the spec records
which environments a variable belongs to.

Nothing is required by the application. With an empty environment the app runs
as a bring-your-own-token dashboard: you paste a Toggl token into Settings and
it stays in that browser's localStorage. `DEPLOYMENT_TOPOLOGY` in the spec
records what track.zicha.dev and its previews must have, so that shape cannot
change by accident. A fork with a different setup empties that object; the
format checks and combination rules still apply, because they follow from the
code.

## What the variables decide

### Data source: `MONGODB_URI` and `APP_MODE`

| `MONGODB_URI` | `APP_MODE` | Result |
| --- | --- | --- |
| unset | (ignored) | **Toggl mode.** Entries come from Toggl. No settings sync. |
| set | unset | **Standalone mode.** The app serves its own MongoDB store. Toggl is never contacted and `TOGGL_API_TOKEN` is ignored. |
| set | `toggl` | **Toggl mode with settings sync.** Entries from Toggl; MongoDB holds only the synced settings. |

`APP_MODE` is required in production because of the middle row: without it the
live dashboard would switch to an empty standalone store and still deploy
successfully.

`MONGODB_DB` names the database. The code default is `toggl-quick-view`
(`lib/store/mongo.ts`). `client.db()` always gets an explicit name, so a
database in the connection-string path is ignored.

### Access: `APP_PASSWORD`

The gate is on only when `APP_PASSWORD` is set and there is something
server-side to protect: `TOGGL_API_TOKEN` or `MONGODB_URI` (`gateEnabled()` in
`lib/serverAuth.ts`).

- `MONGODB_URI` without `APP_PASSWORD` is an **error**. The store and sync
  routes write and refuse to do so unauthenticated, so the deployment would boot
  and report itself misconfigured.
- `TOGGL_API_TOKEN` without `APP_PASSWORD` is a warning in deployments: anyone
  with the URL can read your time entries. A public dashboard is allowed.
- `APP_PASSWORD` with neither has no effect.

The session signing key is derived from the password, so changing
`APP_PASSWORD` invalidates every 7-day session at once.

### Toggl polling: `TOGGL_API_TOKEN` and `TOGGL_CACHE_INTERVAL`

With `TOGGL_API_TOKEN` set, the server holds the token and Settings hides the
token field. `TOGGL_CACHE_INTERVAL` (seconds, or `1`/`true`/`on`/`yes` for the
180 s default) turns on a shared server-side cache. It only applies with
`TOGGL_API_TOKEN` in Toggl mode. While it is set, Settings hides the per-device
"Refresh interval" picker, since every viewer sees the same data.

Toggl's Free plan allows 30 requests per hour per account (one per 120 s).
`env:check` warns below 120. The app clamps values under 30 s to 30 s.

### PDF templates: `PDF_TEMPLATE_PACK_REPO`, `_REF`, `_TOKEN`

These are read at build time. Before `next dev` and `next build`,
`scripts/sync-pack.mjs` checks the repository out into `pdf-templates/` and the
app compiles its templates in. See README → "Private template packs". Unset,
nothing is fetched and the app offers only its generic Timesheet template.

- What gets compiled in depends on whether `pdf-templates/` exists, not on the
  variable. Clearing the variable stops updates but keeps an existing checkout;
  `rm -rf pdf-templates` removes it. The script never deletes a checkout. A
  deployment starts from a fresh clone, so there the variable decides.
- Deployments must use the **https** remote: a Vercel build has no ssh key, and
  `env:check` rejects an ssh remote outside dev. Locally, ssh works with your
  own key and needs no token.
- A private pack over https needs `PDF_TEMPLATE_PACK_TOKEN`: a GitHub
  fine-grained PAT with **Contents: Read** on that repository, marked Sensitive
  in Vercel. When it expires, builds fail at the checkout.
- `PDF_TEMPLATE_PACK_REF` is a branch, tag or commit; blank means `main`. Pin a
  commit if pack changes should not reach the next deployment on their own.
- A configured pack that cannot be fetched **fails the build**, so a deployment
  never ships without its templates. The exception is a network failure when a
  checkout is already on disk: the script keeps it and carries on.

### Timestamping: `TSA_URL` and `TSA_CREDENTIALS`

`TSA_URL` is an RFC 3161 timestamp authority, proxied by `/api/timestamp`. With
it set, signed PDF exports are PAdES-B-T instead of B-B, so signatures keep
verifying after the signing certificate expires. Only a hash is sent. Blank
turns timestamping off. Free authorities (DigiCert, freetsa.org) work in Adobe,
but the EU DSS validator reports them as INDETERMINATE because they are not on
the EU Trust List; a clean DSS report needs a qualified authority such as I.CA
or PostSignum. `TSA_CREDENTIALS` is `user:password` for HTTP Basic, ignored
without `TSA_URL`. Both are blank locally and in production. See
`docs/pdf-signing-v2.md`.

## Getting a working .env

### By hand

```bash
cp .env.tpl .env
pnpm env:check     # reports what is missing or contradictory
pnpm dev
```

Then edit `.env`:

- `TOGGL_API_TOKEN` holds a 1Password reference. Replace it with your token
  from the bottom of https://track.toggl.com/profile, or blank it and enter a
  token in Settings instead.
- `PDF_TEMPLATE_PACK_REPO` points at a private repository. Blank it unless you
  have access, or the dev server fails at the pack checkout.

### With 1Password

```bash
git clone …
pnpm install
op signin
pnpm env:pull      # writes .env
pnpm env:check
pnpm dev
```

`op inject` writes nothing if any reference fails, so a failed pull never leaves
a half-written `.env`.

## Running locally

```bash
pnpm dev        # starts MongoDB, then next dev on :3000
pnpm devsafe    # deletes .next, then next dev (does not start MongoDB)
pnpm db         # only the database
pnpm db:stop    # stop it
```

If `pnpm dev` started the container, Ctrl+C stops it. If it was already running
(from `pnpm db`), it is left running.

The container is `mongo:8` on port **27018**, so a MongoDB already on port
27017 keeps working. It has no authentication: it binds to 127.0.0.1 only and
holds throwaway data. Data survives `pnpm db:stop` in the `mongodata` volume;
`docker compose down -v` deletes it.

Two things to know:

- **You share production's Toggl rate limit.** Local dev uses the same
  personal token, and Toggl counts per account. `.env.tpl` sets
  `TOGGL_CACHE_INTERVAL=600` (6 requests/hour), so the local dashboard is
  stale by design. Lower it when working on data, remembering the two budgets
  add up. Blanking it costs more: without the shared cache every browser
  refresh is an upstream request.
- **There is no password or database by default.** `.env.tpl` leaves
  `APP_PASSWORD` blank and the MongoDB block commented out. To work on settings
  sync or standalone mode, uncomment that block (keep `APP_MODE=toggl` for sync,
  drop it for standalone) and set `APP_PASSWORD` to anything, for example
  `localdev`. Set both or neither: `env:check` fails on a database without a
  password. When the gate is on, `env:check` prints a note saying so.

## Running op without a prompt per command

With only the desktop app integration, every `op` call asks for biometrics or a
PIN. A service account authenticates by token and can be limited to one vault:

```bash
op service-account create dev-machine --vault "Development:read_items"
```

Put the token it prints in `OP_SERVICE_ACCOUNT_TOKEN` in your shell profile.
`pnpm env:pull` then runs without interaction.

While that variable is set, every `op` command uses the service account and
sees only its vault. To act as yourself for one command:
`OP_SERVICE_ACCOUNT_TOKEN= op …`. Service accounts cannot read Personal or
Private vaults, which is why project config is not kept there.

## The 1Password layout

The `Development` vault holds config for every project. A vault is an access
boundary, not a namespace, so the item name carries the project and
environment: `<repo>-dev`, `<repo>-preview`, `<repo>-prod`, all Secure Notes.

```
Development
├── toggl-track-quick-view-dev
├── toggl-track-quick-view-preview
├── toggl-track-quick-view-prod
├── vercel-zicha-dev-ci          (shared across projects)
└── …items for other projects
```

Each value is a custom field labelled with the exact variable name, so a
reference like `Development/toggl-track-quick-view-prod/MONGODB_URI` resolves.
Use the password field type for secrets and text for the rest.

The references are literals in the committed templates. Renaming the vault or
an item breaks `pnpm env:pull` unless the templates change in the same commit.

### toggl-track-quick-view-dev

| Field | Source |
| --- | --- |
| `TOGGL_API_TOKEN` | Bottom of https://track.toggl.com/profile. The same token as production; Toggl issues one per account. |

Everything else local dev needs is a literal in `.env.tpl`. There is no
`APP_PASSWORD` field: local dev has no gate by default, and when you turn it on
you choose the value.

### toggl-track-quick-view-prod

| Field | Source |
| --- | --- |
| `TOGGL_API_TOKEN` | Bottom of https://track.toggl.com/profile. Regenerating it there invalidates the old one immediately. |
| `MONGODB_URI` | MongoDB Atlas, cluster `timetrack-quick-view`, Connect > Drivers. Atlas shows the password only when the user is created. |
| `APP_PASSWORD` | Chosen by us. |
| `PDF_TEMPLATE_PACK_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens → Fine-grained. Repository access: `toggl-track-quick-view-pdf-templates` only, **Contents: Read**. Shown once. |

Vercel never returns the value of a Sensitive variable, so 1Password is where
secrets are kept and Vercel is only where they run. If a value has not been
recovered yet, create the field with the literal `replaceMe`. A blank custom
field is hidden in the 1Password UI, and `validateEnv` rejects `replaceMe`, so
the gap stays visible.

`MONGODB_DB` is not set in production (neither here nor in Vercel), so
production uses the `toggl-quick-view` default. The cluster and the database in
the connection-string path are both called `timetrack-quick-view`, but the path
is ignored: the live data is in `toggl-quick-view`.

### toggl-track-quick-view-preview

Preview has no committed template, so this item is its only full record,
non-secret values included.

| Field | Value | Compared with production |
| --- | --- | --- |
| `APP_MODE` | `toggl` | Same Vercel variable. |
| `TOGGL_API_TOKEN` | secret | Same Vercel variable. |
| `TOGGL_CACHE_INTERVAL` | `170` | Same Vercel variable. |
| `MONGODB_URI` | secret | Identical connection string: same cluster, same credentials. |
| `MONGODB_DB` | `timetrack-quick-view` | **Preview only. Keeps preview out of production data.** |
| `APP_PASSWORD` | secret | Its own value, so a leaked preview password does not open production. |
| `PDF_TEMPLATE_PACK_REPO` | https remote | Same Vercel variable. |
| `PDF_TEMPLATE_PACK_TOKEN` | secret | Same Vercel variable; one PAT serves both. |

Preview and production share one Atlas cluster and one database user. Only
`MONGODB_DB` keeps a branch deployment from writing to the live settings, so the
spec marks it required in preview: delete it in Vercel and the next preview
build fails. For real isolation, give preview its own database user scoped to
`timetrack-quick-view`, or its own cluster, and put that connection string in
this item.

### vercel-zicha-dev-ci

This item configures the `zicha-dev` Vercel team, not an app environment.
GitHub Actions use its `VERCEL_TOKEN` to re-alias preview domains, for this
project's `beta.track.zicha.dev` and zicha-travel's `preview.zicha.travel`.

| Field | Source |
| --- | --- |
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens, scoped to the `zicha-dev` team, no expiration. Shown once. |

GitHub Actions secrets cannot be read back, so the token is kept in 1Password.
To set it on a repository, read it into a variable and check it is non-empty
before calling `gh`:

```bash
token=$(op read "op://Development/vercel-zicha-dev-ci/VERCEL_TOKEN") \
  && [ -n "$token" ] \
  && printf %s "$token" | gh secret set VERCEL_TOKEN -R vojtechzicha/<repo>
```

Two ways this goes wrong, both silent in GitHub:

- If `op read` fails (for example, a biometric prompt times out), a plain pipe
  into `gh` stores an empty secret over the working one.
- `gh secret set` with neither `--body` nor a pipe reads stdin. With no
  terminal attached (an editor shell, a script, an agent) it stores an empty
  string without error.

The workflow fails on an empty `VERCEL_TOKEN`, and a successful run is the only
confirmation that the secret works.

## Adding a variable

1. Add it to `scripts/env-spec.mjs`: name, scope, description, format check,
   and a `DEPLOYMENT_TOPOLOGY` entry if our deployments need it.
2. Add it to `.env.tpl` and `.env.prod.tpl`. A preview-only variable skips this:
   mark it `appliesTo: ['preview']`.
3. If it is a secret, add the field to the 1Password item(s).
4. Set it in Vercel under Settings → Environment Variables.

Steps 1 and 2 go in the pull request. Steps 3 and 4 need someone with the
credentials, so list them in the PR description. Other machines pick up the
change with `git pull && pnpm env:pull`.

`pnpm env:check` runs at the start of `vercel-build`. A required variable that
is missing in Vercel fails the pull request's own preview build.

## Production

Vercel is the source of truth for what production runs. 1Password holds the
recoverable copy and `.env.prod.tpl` documents the shape. Nothing syncs
1Password into Vercel automatically; values are pasted by hand.

To reproduce a production problem locally:

```bash
vercel env pull .env.prod --environment production
```

Sensitive variables (every secret here) come back as the literal `[SENSITIVE]`.
`validateEnv` rejects that value, since a file full of it looks configured but
fails at the service.

## Variables not in the templates

- Set by the platform: `NODE_ENV`, `PORT`, `CI`, `VERCEL`, `VERCEL_ENV`,
  `VERCEL_GIT_COMMIT_SHA`.
- Computed by `next.config.js` at build time: `NEXT_PUBLIC_BUILD_ID` (from the
  git commit, for the post-deploy refresh hint) and `NEXT_PUBLIC_VERCEL_ENV`
  (from `VERCEL_ENV`, for the preview app name in `lib/pwa.ts`).
- Script flags: `TZ`, which `scripts/check-windows.ts` changes per case to test
  DST boundaries.
- Machine tooling: `OP_SERVICE_ACCOUNT_TOKEN` belongs in your shell profile.
  `VERCEL_OIDC_TOKEN` is written to `.env.local` by the Vercel CLI and unused.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `op inject` errors on a reference | The field is missing from that item, or its label does not match the variable name exactly. |
| `pnpm env:pull` writes nothing | Not signed in. Run `op signin`. |
| `op: command not found` | The install directory is not on `PATH`. |
| A template change never takes effect | A `.env.local` overrides `.env`. `pnpm env:check` notes when one exists; delete it. `vercel link` and `vercel env pull` recreate it. |
| A variable is set but the service rejects it | The value is `[SENSITIVE]` from `vercel env pull` or an unreplaced `replaceMe`. `pnpm env:check` catches both. |
| The app says it is misconfigured | `MONGODB_URI` is set without `APP_PASSWORD`. |
| Settings sync is missing from the UI | Sync needs `MONGODB_URI` and `APP_PASSWORD`, plus `APP_MODE=toggl` to keep Toggl as the source. |
| The dashboard shows an empty store instead of Toggl data | `MONGODB_URI` is set without `APP_MODE=toggl`: standalone mode. |
| Toggl returns 429 | The hourly budget is per account and local dev shares it with production. Raise `TOGGL_CACHE_INTERVAL` in `.env`. |
| The "Refresh interval" picker is gone from Settings | Expected while `TOGGL_CACHE_INTERVAL` is set. |
| The build fails with `pdf-pack  ERROR` | The template pack could not be checked out. Usually an expired `PDF_TEMPLATE_PACK_TOKEN`, an ssh remote in a deployment, or a local ssh remote you have no access to. |
| The export dialog has no PDF template picker | Only one template is registered, so no pack is checked out. Run `pnpm pack:sync` locally; check `PDF_TEMPLATE_PACK_REPO` in a deployment. |
| `pnpm dev` fails to start the database | Docker Compose is unavailable or port 27018 is taken. `pnpm db` on its own shows the error. |
| `beta.track.zicha.dev` stops following deployments | The `VERCEL_TOKEN` repo secret is missing, empty or revoked. Check the latest "Alias preview domain" run and re-set the secret from `vercel-zicha-dev-ci`. |
