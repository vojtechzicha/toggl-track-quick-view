# toggl-track-quick-view

A one-screen view for tracking a work day against a weekly target, reading from
Toggl Track or from its own MongoDB store. Next.js App Router, deployed on
Vercel at track.zicha.dev.

- `README.md` is the product spec: targets, Short Friday, billing tags,
  timesheets, PDF export and signing, workspaces, rate limits. Read the relevant
  section before changing behaviour; most odd-looking special cases are
  specified there.
- `docs/ENVIRONMENT.md` is the configuration guide: templates, 1Password,
  Vercel, every variable.
- `docs/pdf-signing-v2.md` covers PDF signing.

## Commands

```bash
pnpm env:pull         # .env from .env.tpl via 1Password (op inject)
pnpm env:pull:prod    # .env.prod from .env.prod.tpl (live production secrets)
pnpm env:check        # Validate the environment against scripts/env-spec.mjs
pnpm pack:sync        # Check the private PDF template pack out into pdf-templates/

pnpm dev              # Start MongoDB (Docker, port 27018), sync the pack, next dev
pnpm devsafe          # Sync the pack, delete .next, next dev (no MongoDB)
pnpm db / db:stop     # Start / stop only MongoDB

pnpm check            # All checks below. No network, no database.
pnpm check:money      # Money/allocation arithmetic
pnpm check:codes      # Billing codes
pnpm check:windows    # Start windows and DST boundaries (reassigns process.env.TZ)
pnpm check:export     # Export scope
pnpm check:templates  # PDF template registry (app + pack)
pnpm check:fonts      # Fonts and pdfmake VFS for the registered templates
pnpm check:signature  # PDF signing against scripts/fixtures/
pnpm check:pwa        # Which browsers get the native install prompt vs the guide
pnpm check:pack       # The pack's own checks, if one is checked out

pnpm build            # Sync the pack, next build
npx tsc --noEmit      # Typecheck (`pnpm lint` has no ESLint config yet)
```

Run `pnpm check` before proposing a change. If `pnpm dev` started the MongoDB
container, Ctrl+C stops it; if it was already running (`pnpm db`), it is left up.

## Configuration traps

Details and rationale: `docs/ENVIRONMENT.md`.

- `scripts/env-spec.mjs` lists every variable and the cross-variable rules;
  `pnpm env:check` enforces them and runs first in `vercel-build`. It is plain
  `.mjs` because it runs under bare Node before anything is compiled.
- **Adding a variable:** spec, `.env.tpl` and `.env.prod.tpl` in one commit.
  Preview-only variables get `appliesTo: ['preview']` and no template entry.
  Values go into 1Password and Vercel by hand; say so in the PR.
- **Never write an `op://` string in a template comment.** `op inject` resolves
  comments too, and a bad reference breaks the pull. Write the path without the
  scheme.
- `MONGODB_URI` and `APP_MODE` decide what the deployment is:

  | `MONGODB_URI` | `APP_MODE` | Result |
  | --- | --- | --- |
  | unset | (ignored) | Toggl mode, no sync |
  | set | unset | Standalone mode: own store, Toggl never contacted |
  | set | `toggl` | Toggl mode with settings sync |

  Production needs `APP_MODE=toggl`. Without it the live dashboard becomes an
  empty standalone store and still deploys green.
- **`MONGODB_DB` is all that separates preview data from production.** Both use
  the same Atlas cluster and connection string. Production leaves `MONGODB_DB`
  unset (code default `toggl-quick-view`), preview sets `timetrack-quick-view`.
  The spec marks it required in preview; keep that rule. The connection-string
  path is ignored because `client.db()` always gets an explicit name.
- `MONGODB_URI` without `APP_PASSWORD` is an error (those routes write).
- `DEPLOYMENT_TOPOLOGY` in the spec is our deployment's shape, not an app
  requirement. An empty environment is a supported mode.
- Local `.env.tpl` has no password and no database by default. To work on sync
  or standalone mode, uncomment its MongoDB block and set `APP_PASSWORD`
  together. That connection string must stay a literal pointing at the local
  container.
- `.env.local` outranks `.env`. The Vercel CLI creates one; delete it.

## PDF templates

`lib/export/pdf/` is a registry: each template is a `PdfTemplate`
(`lib/export/pdf/types.ts`) and the export dialog is driven by those
declarations. README → "Adding a PDF template" is the guide.

This repo ships only the generic `timesheet` template. The engagement-specific
templates live in the private repo `toggl-track-quick-view-pdf-templates`,
which `scripts/sync-pack.mjs` checks out into `pdf-templates/` (gitignored)
before `dev` and `build`, driven by `PDF_TEMPLATE_PACK_REPO` / `_REF` / `_TOKEN`.

- **`pdf-templates/` is disposable.** It is force-checked-out on every
  `pnpm dev` and `pnpm build`, so edits there are lost. Edit, commit and push
  in the pack's own clone (`../toggl-track-quick-view-pdf-templates`). Nothing
  from the pack belongs in a commit here.
- The `@pdf-template-pack` alias resolves to `pdf-templates/index.ts` if it
  exists, else `lib/export/pdf/emptyPack.ts`. That pair is spelled out in three
  places that must agree: `next.config.js`, `tsconfig.json` `paths`, and
  `scripts/resolve-hooks.mjs`.
- A clone without a pack must build and work; check both states. A configured
  pack that cannot be fetched fails the build.
- Deployments need the https remote plus a token (no ssh key in a Vercel build);
  `env:check` rejects an ssh remote outside dev.
- It is not a git submodule, so forks of this public repo don't try to fetch a
  private one.

## Other traps

- Toggl's rate limit (30 requests/hour on Free) is per account, and local dev
  uses the same token as production. `.env.tpl` sets
  `TOGGL_CACHE_INTERVAL=600` for that reason. Blanking it costs more, not less:
  with no shared cache every browser refresh hits Toggl.
- The browser cannot call Toggl directly (CORS). Everything goes through
  `app/api/toggl/[...path]`.
- Rotating `APP_PASSWORD` invalidates every session: the signing key is derived
  from it (`lib/serverAuth.ts`).
- "Standalone" means the no-Toggl store mode. The PWA display mode is called
  `installed` in code to avoid the clash.
- Old tabs compare their build id against `GET /api/version` and ask to refresh
  (`components/UpdateHint.tsx`). This matters with settings sync: a tab on an
  old build drops settings keys it doesn't know on its next save.
- `beta.track.zicha.dev` follows the newest preview
  (`.github/workflows/preview-alias.yml`), so preview sessions and PWA installs
  survive redeploys.
