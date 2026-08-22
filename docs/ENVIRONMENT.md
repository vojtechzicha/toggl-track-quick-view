# Environment configuration

`.env` is never committed and never copied between machines. What git carries
is a template listing every variable the code reads, with a literal value
wherever the value is not secret. You produce your own `.env` from it, either by
hand or with 1Password.

```
.env.tpl       ──op inject──▶  .env       local development    (gitignored)
.env.prod.tpl  ─────────────▶  .env.prod  production reference (gitignored)
scripts/env-spec.mjs        ─▶  the list of variables that exist, and their rules
```

| File | Committed | What it is |
| --- | --- | --- |
| `.env.tpl` | yes | Local dev config. Literals for everything non-secret, 1Password references for the rest. |
| `.env.prod.tpl` | yes | The same variables with production values. A recoverable copy of what Vercel holds. |
| `scripts/env-spec.mjs` | yes | Every variable the code reads, what it means, and which combinations are contradictory. |
| `.env` | no | Yours. Loaded automatically by Next and by `pnpm env:check`. |
| `.env.prod` | no | Generated on demand. Live production secrets. Read by nothing automatically. |

`MONGODB_URI` in `.env.tpl` is a literal pointing at the local Docker database.
That is deliberate: the default must not be able to reach production.

### Three environments, two templates

Local development and production each have a template. Vercel's preview
deployments are the third environment and have none, because nobody generates a
`.env` for them: Vercel injects the values at build time, and 1Password keeps a
recoverable copy in the `toggl-track-quick-view-preview` item. Duplicating
production secrets into a third committed template would mean maintaining the
same secret in two places.

A variable can therefore belong to any of the three, which is what `appliesTo`
in `scripts/env-spec.mjs` records.

Which variables are *required* is a separate question, and a different kind of
statement. Nothing here is required by the application — every variable is
optional to the code, and an empty environment is a supported mode. What
`DEPLOYMENT_TOPOLOGY` records is the shape `track.zicha.dev` and its previews
actually run, so that shape cannot change by accident: losing `APP_MODE` would
turn the live dashboard into an empty standalone store and still deploy green.
A fork with a different shape empties that object and every requirement relaxes,
while the format checks and contradiction rules — which follow from the code
rather than from anyone's topology — still apply.

## What the variables actually decide

This app has no variable it cannot start without. With a completely empty
environment it runs as a bring-your-own-token dashboard: you paste a Toggl token
into Settings and it lives in that browser's localStorage. Every variable below
turns that into something else, and the interesting failures are combinations
rather than individual values.

**Which data the app serves** is decided by two variables together:

| `MONGODB_URI` | `APP_MODE` | Resulting deployment |
| --- | --- | --- |
| unset | — | **Toggl mode.** Time entries come from Toggl. No settings sync. |
| set | unset | **Standalone mode.** The app serves its own MongoDB store; Toggl is never contacted and `TOGGL_API_TOKEN` is ignored. |
| set | `toggl` | **Toggl mode + settings sync.** Entries from Toggl, MongoDB holds only the synced setup. |

That middle row is why `APP_MODE` is marked required in production. It is the
only thing standing between the live dashboard and a silent switch to an empty
standalone store, and the switch would look like a working deploy.

**Who can read it** is `APP_PASSWORD`, and it is only meaningful when there is
something server-side to protect — `gateEnabled()` in `lib/serverAuth.ts` wants
`APP_PASSWORD` *and* one of `TOGGL_API_TOKEN` or `MONGODB_URI`. So:

- `TOGGL_API_TOKEN` without `APP_PASSWORD` serves your real time entries to
  anyone who learns the URL. `pnpm env:check` warns; it is not an error,
  because a deliberately public dashboard is a legitimate thing to want.
- `MONGODB_URI` without `APP_PASSWORD` is an **error**. Those routes write, and
  they refuse to write unauthenticated, so the deployment boots and then reports
  itself misconfigured to the browser. Better to fail the build.
- `APP_PASSWORD` with neither is inert — each browser holds its own token and
  there is nothing to gate.

Rotating `APP_PASSWORD` invalidates every session immediately: the HMAC signing
key is derived from the password itself, so old 7-day tokens stop verifying the
moment it changes.

**How often Toggl is polled** is `TOGGL_CACHE_INTERVAL`, which only does
anything alongside `TOGGL_API_TOKEN` in Toggl mode. While it is set, the shared
server-side cache is on and the per-device "Refresh interval" picker disappears
from Settings — with one server-held token every viewer is the same user looking
at the same data, so one cadence serves them all. Toggl's Free plan allows **30
requests/hour per account**, which is one per 120s; `env:check` warns below that.

**Which PDF templates the export dialog offers** is
`PDF_TEMPLATE_PACK_REPO`, and it is the one variable here that is read at BUILD
time rather than at runtime. Before `next build` (and before `next dev`),
`scripts/sync-pack.mjs` checks that repository out into `pdf-templates/`, and
the app compiles its templates in alongside its own; see "Private template
packs" in README.md for what a pack is. Unset, nothing is fetched and the app
offers only the generic **Timesheet** template it ships — which is a supported
deployment, and what a plain clone of this repository does.

- What is compiled in is decided by the **directory**, not by the variable: the
  variable says what to fetch into `pdf-templates/`, and the alias resolves
  against that directory existing. Clearing the variable on a machine that has
  already synced therefore stops the updates but keeps the pack — the script
  prints exactly that, and `rm -rf pdf-templates` is how you build without one.
  It never deletes a checkout itself: it cannot tell one it made from one you
  cloned by hand. A deployment starts from a fresh clone, so there the variable
  is the whole story.

- The remote must be **https** in a deployment. There is no ssh key in a Vercel
  build, so an ssh remote cannot be fetched there; `env:check` rejects it as an
  error rather than letting the build discover it. Locally, ssh is the right
  form — your own key already has access and no token is needed.
- A private pack over https needs `PDF_TEMPLATE_PACK_TOKEN`: a GitHub
  fine-grained PAT with **Contents: Read** on that one repository, marked
  Sensitive in Vercel. It expires, and the first sign is a build failing at the
  checkout.
- `PDF_TEMPLATE_PACK_REF` pins a branch, tag or commit; blank means `main`. Pin
  it to a commit when a change in the pack should not be able to alter the next
  deployment of this app on its own.
- A configured pack that cannot be fetched **fails the build**. Continuing would
  produce a green deployment whose export dialog had quietly lost every layout
  its documents are filed under — the same failure shape `APP_MODE` guards
  against. Offline on a laptop is the one exception: a checkout already on disk
  is kept and the dev server starts.

## Getting a working .env

### By hand

Nothing here depends on 1Password. Copy the template and fill it in:

```bash
cp .env.tpl .env
pnpm env:check     # says what is missing or contradictory
pnpm dev
```

One line reads `op://…` and is a placeholder for a value you supply:
`TOGGL_API_TOKEN`, from the bottom of https://track.toggl.com/profile. Blank it
instead and the app falls back to asking for a token in Settings, which is
enough to see the dashboard. Nothing else in the file needs touching — the
remaining live line is a literal, and the rest is a commented-out block you
enable only to work on settings sync or standalone mode.

### With 1Password

This project keeps the secrets in 1Password and generates `.env` from the
template, so a new machine needs no hand-editing and no file transfer:

```bash
git clone …
pnpm install
op signin
pnpm env:pull      # writes .env
pnpm env:check
pnpm dev
```

`op inject` resolves every reference in the file and refuses to write anything
if one of them fails, so a broken pull cannot leave a half-written `.env`
behind.

## Running locally

```bash
pnpm dev        # starts MongoDB, then next dev on :3000
pnpm devsafe    # same, minus a stale .next
pnpm db         # just the database, for a longer session
pnpm db:stop    # and down again
```

`pnpm dev` brings `docker compose` up before Next and leaves the database as it
found it: if the container was already running — because you ran `pnpm db` in
another terminal — Ctrl-C leaves it running. If `pnpm dev` started it, Ctrl-C
takes it down.

The container is `mongo:8` on **port 27018**, not Mongo's default 27017, so a
MongoDB you already run on this machine keeps working and nothing here can be
mistaken for it. There is no authentication: it is bound to localhost and holds
throwaway data, and the whole point of a local database is that it cannot be the
production one. Data survives `pnpm db:stop` in the `mongodata` volume; to start
genuinely empty, `docker compose down -v`.

Two things about local dev worth knowing before they surprise you:

- **You share production's Toggl rate limit.** The dev item holds the same
  personal API token, and Toggl counts requests per account. `.env.tpl` sets
  `TOGGL_CACHE_INTERVAL=600` — 6 requests/hour — for that reason, which also
  means the local dashboard is deliberately stale. Lower it when you are working
  on data rather than layout, and remember the two deployments add up. Blanking
  it is not the cheap option: with no shared cache every browser refresh becomes
  its own upstream request.
- **There is no password locally, and no database.** `.env.tpl` ships
  `APP_PASSWORD` blank and the whole MongoDB block commented out, so the default
  `pnpm dev` is the plain Toggl dashboard: nothing to unlock, nothing to
  connect. Production needs the gate because the server holds the Toggl token
  and the URL is reachable; localhost is neither.

  Turn it on when you work on **settings sync or standalone mode** — uncomment
  the three-line block at the bottom of `.env.tpl` and set `APP_PASSWORD` to
  anything (`localdev` is what these docs assume). Both halves together, never
  one: those routes write, and `pnpm env:check` fails on a database without a
  gate. `pnpm env:check` also notes when the gate is active, so a password
  prompt is never a mystery.

## Authorizing op without a prompt per command

With only the desktop app integration, every `op` invocation asks for biometrics
or a PIN, which makes scripted use painful. A service account authenticates by
token instead, and can be scoped to a single vault:

```bash
op service-account create dev-machine --vault "Development:read_items"
```

Store the token it prints once, in `OP_SERVICE_ACCOUNT_TOKEN`. `pnpm env:pull`
then runs without interaction.

While that variable is set, every `op` command uses the service account and sees
only the vault it was granted. To act as yourself for one command, clear it for
that invocation: `OP_SERVICE_ACCOUNT_TOKEN= op …`, or
`env -u OP_SERVICE_ACCOUNT_TOKEN op …`. A service account cannot read Personal
or Private vaults at all, which is the reason project config does not live in
those.

## The 1Password layout

One vault, `Development`, holds the config for every project rather than one
vault per repository. A vault is an access boundary, deciding who and what can
read its contents, not a namespace. Splitting per repository multiplies the
sharing decisions without separating anything, and a service account for CI
would have to be granted each vault separately. Keeping app config out of
`Personal` is the separation that pays off.

The item carries the project and the environment, as `<repo>-dev`,
`<repo>-preview` and `<repo>-prod`, all category Secure Note:

```
Development
├── toggl-track-quick-view-dev       1 field
├── toggl-track-quick-view-preview   6 fields
├── toggl-track-quick-view-prod      3 fields
├── vercel-zicha-dev-ci              1 field   (team-wide, not per-project)
└── …-dev / …-preview / …-prod for every other project
```

Each item is a complete snapshot of one environment, so switching hosting or
rotating a service means reading one item instead of hunting through a password
manager.

Add each value as a custom field whose label is exactly the variable name. That
is what makes a reference like `Development/toggl-track-quick-view-prod/MONGODB_URI`
resolve. Use the password field type for secrets, since it stays concealed in
the UI, and text for the rest.

Renaming the vault or an item breaks `pnpm env:pull` for everyone: the
references are literals in the committed templates. Change the templates in the
same commit.

### Item toggl-track-quick-view-dev

| Field label | Where the value comes from |
| --- | --- |
| `TOGGL_API_TOKEN` | The same personal token as production — bottom of https://track.toggl.com/profile. Toggl issues one per account, so there is no separate dev credential to have. |

This is the only value local development takes from 1Password. Everything else
it needs is a literal in `.env.tpl` — the cache interval, and the commented-out
Docker connection string, database name and `APP_MODE` that turn on sync. None
of them is a secret, and keeping them in git means a diff of that file shows a
real configuration change. `APP_PASSWORD` is blank there, so there is no local
password to look up.

Note there is no `APP_PASSWORD` field in this item, and that is not an
oversight: local development has no gate by default, and when you opt in the
value is yours to invent.

### Item toggl-track-quick-view-prod

| Field label | Where the value comes from |
| --- | --- |
| `TOGGL_API_TOKEN` | https://track.toggl.com/profile, bottom of the page. Regenerating it there invalidates the old one immediately. |
| `MONGODB_URI` | MongoDB Atlas, the `timetrack-quick-view` cluster, Connect > Drivers. Atlas shows the password only when the user is created. |
| `APP_PASSWORD` | Chosen, not issued. Recovered by hand — see below. |
| `PDF_TEMPLATE_PACK_TOKEN` | GitHub → Settings → Developer settings → Personal access tokens → Fine-grained. Repository access limited to `toggl-track-quick-view-pdf-templates`, permission **Contents: Read**. Shown once at creation. |

`APP_PASSWORD` is marked Sensitive in Vercel, so neither the CLI nor the
dashboard can ever read it back. When this item was created the live value
existed nowhere else, and it was recovered by hand afterwards. That gap is the
normal case for a Sensitive variable, not an accident — Vercel is where a secret
RUNS, never where it is kept.

The convention for such a gap: create the field holding the literal
`replaceMe`. A blank custom field does not show up in the 1Password UI at all,
so it would be invisible rather than obviously unfinished, and `op inject`
would fail outright. `validateEnv` rejects that exact string, so a
`replaceMe` that nobody got round to replacing can never be mistaken for a real
value — `pnpm env:pull:prod` produces a deliberately unusable `.env.prod` until
someone pastes the real one in.

`MONGODB_DB` is **not** in this item, because it is not set in Vercel either.
Production therefore uses the `toggl-quick-view` default from
`lib/store/mongo.ts`. Worth knowing when you go looking for the data: the Atlas
cluster and the database named in the connection string path are both
`timetrack-quick-view`, but `client.db()` is always called with an explicit
name, so the path is ignored and the live sync documents sit in
`toggl-quick-view`.

### Item toggl-track-quick-view-preview

Preview has no committed template, so this item is the whole record of it —
non-secret rows included.

| Field | Value | How preview differs from production |
| --- | --- | --- |
| `APP_MODE` | `toggl` | Same row in Vercel, shared with production. |
| `TOGGL_API_TOKEN` | — | Same row in Vercel, shared with production. |
| `TOGGL_CACHE_INTERVAL` | `170` | Same row in Vercel, shared with production. |
| `MONGODB_URI` | — | Same connection string as production, byte for byte: same Atlas cluster, same credentials. |
| `MONGODB_DB` | `timetrack-quick-view` | **Preview-only, and load-bearing.** |
| `APP_PASSWORD` | — | **Its own value**, so a leaked preview password cannot open production. |
| `PDF_TEMPLATE_PACK_REPO` | — | Same row in Vercel, shared with production. |
| `PDF_TEMPLATE_PACK_TOKEN` | — | Same row in Vercel, shared with production — one PAT reads the pack for both. |

Preview and production share one Atlas cluster and one database user. What keeps
a branch deployment out of the live synced setup is `MONGODB_DB` alone:
production leaves it unset and lands in the `toggl-quick-view` default, preview
sets it to `timetrack-quick-view`. Two names in two places, and the separation
is that difference.

That is thin enough to be worth a guard, so `scripts/env-spec.mjs` marks
`MONGODB_DB` **required in preview**. Delete that row in Vercel and the next
preview build fails instead of quietly writing a branch's settings over the real
ones. Nothing enforces the production side, because production's value is the
code default — there is no row to delete.

If you would rather have real isolation than a guarded convention, give preview
its own database user scoped to `timetrack-quick-view`, or its own cluster, and
put that connection string in this item instead. Nothing else has to change.

### Item vercel-zicha-dev-ci

The odd one out: it carries no application configuration, and it is **not
scoped to this repository**. `VERCEL_TOKEN` is a Vercel access token for the
`zicha-dev` team, used by GitHub Actions to re-alias preview domains — this
project's `beta.track.zicha.dev` and zicha-travel's `preview.zicha.travel`,
from the one item.

Hence the name. The `<repo>-<env>` convention says the item names what it
configures, and this configures a team, not an app environment. One shared
token also means one thing to rotate.

| Field | Where the value comes from |
| --- | --- |
| `VERCEL_TOKEN` | vercel.com → Account Settings → Tokens, scoped to the `zicha-dev` team, no expiration. Shown once at creation. |

It lives in 1Password rather than only in GitHub for the usual reason: GitHub
Actions secrets are write-only, so a token that exists only there cannot be
copied to a second repository, audited, or recovered. Push it to a repo with:

```bash
op read "op://Development/vercel-zicha-dev-ci/VERCEL_TOKEN" \
  | gh secret set VERCEL_TOKEN -R vojtechzicha/<repo>
```

Two traps, both of which have already bitten:

- `op read` can fail (an unanswered biometric prompt times out), and a naive
  pipe then feeds `gh` an EMPTY value, overwriting a working secret with
  nothing. Read into a variable and check its length before setting.
- `gh secret set` with no value argument reads **stdin**. With no terminal
  attached — inside an editor's shell, a script, an agent — there is no prompt
  and no error: it silently stores an empty string. The workflow's own
  `VERCEL_TOKEN` guard is what surfaces that.

Neither failure is visible from GitHub, because secrets cannot be read back.
The only real confirmation is a workflow run that succeeds.

## Adding a variable

The schema travels through git. Only the value is manual.

1. In code: add it to `scripts/env-spec.mjs` with its name, scope, description,
   where it is required, and any format check.
2. In both templates: `.env.tpl` and `.env.prod.tpl`. A variable that only
   applies to preview deployments skips this step: mark it
   `appliesTo: ['preview']` and leave the templates alone.
3. In 1Password, if it is a secret: add the field to the `-dev`, `-preview` or
   `-prod` item.
4. In Vercel: Settings, Environment Variables.

Steps 1 and 2 are the pull request. Steps 3 and 4 are paste operations only a
human with the credentials can do, so note them in the PR body. Other machines
pick the change up with `git pull && pnpm env:pull`.

`pnpm env:check` runs at the start of `vercel-build`, before `next build`. A
variable declared in code but missing in Vercel fails the build, and it fails
the pull request's own preview deployment first, so the gap surfaces at review
time rather than in production.

## Production

Vercel stays the source of truth for what the deployment runs. 1Password holds
the recoverable copy and `.env.prod.tpl` documents the shape. Nothing pushes
automatically from 1Password into Vercel, because an accidental sync in the
wrong direction is far worse than a rare manual paste.

The other direction is useful when you need to reproduce a production problem
locally:

```bash
vercel env pull .env.prod --environment production
```

Remember that sensitive variables come back as the literal `[SENSITIVE]` —
which is every secret this project has. `validateEnv` rejects that string
precisely because a file full of it looks fully configured and fails at the
service instead.

## Variables that are not in the templates

Deliberately absent:

- Platform-provided: `NODE_ENV`, `PORT`, `CI`, `VERCEL`, `VERCEL_ENV`,
  `VERCEL_GIT_COMMIT_SHA`.
- Build-derived: `NEXT_PUBLIC_BUILD_ID` — computed by `next.config.js` from the
  git commit and baked into the bundle for the post-deploy refresh hint. Nobody
  sets it.
- One-off script flags: `TZ`, which `scripts/check-windows.ts` reassigns per
  case to exercise DST boundaries.
- Machine-level tooling: `OP_SERVICE_ACCOUNT_TOKEN` belongs in your shell
  profile, not in a generated `.env` on every dev machine.
  `VERCEL_OIDC_TOKEN` is written into `.env.local` by the Vercel CLI and nothing
  in this app reads it.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `op inject` errors on a reference | The field does not exist in that item, or its label does not match the variable name exactly. |
| `pnpm env:pull` writes nothing | Not signed in. Run `op signin`. |
| `op: command not found` | The install directory is not on `PATH`. Add it and restart the terminal. |
| A template change never takes effect | A leftover `.env.local` overrides the generated `.env`. `pnpm env:check` prints a note when one exists — delete it. The Vercel CLI recreates it on `vercel link` and `vercel env pull`. |
| A variable is set but the service rejects it | Its value may be the literal `[SENSITIVE]` copied out of `vercel env pull`, or an unreplaced `replaceMe`. `pnpm env:check` catches both. |
| The app says it is misconfigured | `MONGODB_URI` without `APP_PASSWORD`. Set one, or unset the other. |
| Settings sync is missing from the UI | Sync needs both `MONGODB_URI` and `APP_PASSWORD`. In Toggl mode it also needs `APP_MODE=toggl`, or the app switches to standalone instead of syncing. |
| The dashboard shows an empty store instead of Toggl data | `APP_MODE=toggl` is missing while `MONGODB_URI` is set — standalone mode. |
| Toggl starts answering 429 | The hourly budget is per account and local dev shares it with production. Raise `TOGGL_CACHE_INTERVAL` in `.env`. |
| The "Refresh interval" picker vanished from Settings | Expected whenever `TOGGL_CACHE_INTERVAL` is set: the shared server cache drives the cadence for everyone. |
| The build fails at `pdf-pack ERROR` | The configured template pack could not be checked out. Usually an expired `PDF_TEMPLATE_PACK_TOKEN`, or an ssh remote in a deployment. |
| The export dialog lost its PDF template picker | Only one template is registered, so there is nothing to pick — i.e. no pack is checked out. `pnpm pack:sync` locally; check `PDF_TEMPLATE_PACK_REPO` in a deployment. |
| `pnpm dev` fails to start the database | `docker compose` is not available, or port 27018 is taken. `docker compose ps` and `pnpm db` on their own show the real error. |
| The preview domain stops following deployments | The `VERCEL_TOKEN` repo secret is missing, empty or revoked. Check the newest `Alias preview domain` run; re-push it from `vercel-zicha-dev-ci` as above. |
