# =============================================================================
# LOCAL DEVELOPMENT configuration.
#
#   pnpm env:pull        regenerates .env from this file via `op inject`
#
# Only real SECRETS are 1Password references; everything else is a literal, so a
# diff of this file shows actual configuration changes. .env is generated and
# gitignored — never edit it by hand, your change would be overwritten.
#
# Adding a variable? Add it to scripts/env-spec.mjs, here, and to
# .env.prod.tpl, then run `pnpm env:check`. A variable that only applies to
# Vercel PREVIEW deployments is the exception: mark it `appliesTo: ['preview']`
# in the spec and leave both templates alone.
#
# Full walkthrough, including the 1Password layout: docs/ENVIRONMENT.md
# =============================================================================

# The default local run is the plain Toggl dashboard: no database, no password.
# APP_MODE, MONGODB_URI and MONGODB_DB live at the bottom of this file, commented
# out, and turn on what production actually runs.

# -- Toggl --------------------------------------------------------------------
# Your personal token from https://track.toggl.com/profile (bottom of the page).
# Setting it here makes local dev "server-managed", exactly like production: the
# browser never holds a token and Settings hides the token field.
#
# Blank it instead to develop the bring-your-own-token path, where you paste a
# token into Settings and it lives in that browser's localStorage.

TOGGL_API_TOKEN=op://Development/toggl-track-quick-view-dev/TOGGL_API_TOKEN

# Deliberately much slower than production's 170s. Toggl's Free plan allows 30
# requests/hour PER ACCOUNT, and this is the same account production polls, so
# a chatty dev server can push the live dashboard into 429s. At 600s local dev
# costs 6 requests/hour and leaves production its budget.
#
# Lower it when you are working on data rather than layout — just remember the
# two add up. Blanking it is NOT the cheap option: with no shared cache every
# browser refresh becomes its own upstream request.

TOGGL_CACHE_INTERVAL=600

# -- Access -------------------------------------------------------------------
# BLANK locally on purpose. Production sets it (see .env.prod.tpl) because the
# server holds the Toggl token there and the dashboard would otherwise be
# readable by anyone with the URL. On localhost there is no such exposure, and a
# password prompt on every `pnpm dev` is friction that buys nothing.
#
# Set it — together with the MongoDB block below, never on its own — when you
# work on settings sync or standalone mode. Those routes WRITE, and refuse to
# without a gate, so `pnpm env:check` fails on one without the other. Any value
# will do locally; `localdev` is the one the docs use.
#
# With this blank the gate is off entirely: gateEnabled() in lib/serverAuth.ts
# wants a password AND something server-side worth protecting.

APP_PASSWORD=

# -- Settings sync / standalone mode (opt-in) ---------------------------------
# Commented out so the default local run is the plain Toggl dashboard: no
# database, no password, nothing to unlock. `pnpm dev` still starts MongoDB, so
# turning this on is only ever an edit away.
#
# Uncomment ALL THREE lines and set APP_PASSWORD above to get what production
# runs — Toggl as the source, MongoDB for cross-device settings sync:
#
#   APP_MODE=toggl
#   MONGODB_URI=mongodb://localhost:27018/toggl-quick-view
#   MONGODB_DB=toggl-quick-view
#
# Drop the APP_MODE line from that set and you get STANDALONE mode instead: the
# app serves its own MongoDB store and never contacts Toggl. Same database, same
# password requirement, completely different product — see README.md.
#
# The connection string is a literal, and local. That is deliberate: the default
# must never be able to reach production.

# -- PDF template pack --------------------------------------------------------
# The private repository holding the engagement-specific PDF layouts, checked
# out into pdf-templates/ by scripts/sync-pack.mjs before `pnpm dev` and
# `pnpm build`. Blank it and the app offers only the generic Timesheet template
# it ships — which is what a plain clone gets, and a supported way to work.
#
# SSH here, https in the deployments: your own key already has access, so no
# token is needed locally. Offline, the checkout already on disk is kept and the
# dev server starts anyway.

PDF_TEMPLATE_PACK_REPO=git@github.com:vojtechzicha/toggl-track-quick-view-pdf-templates.git

# Branch, tag or commit. Blank means "main", which is what you want locally —
# pin it only to reproduce a specific build.

PDF_TEMPLATE_PACK_REF=
