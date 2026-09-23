# Local development config.
#
#   pnpm env:pull    regenerates .env from this file via `op inject`
#
# Only secrets are 1Password references; everything else is a literal. .env is
# generated and gitignored, so edit this file, not .env.
#
# Adding a variable: add it to scripts/env-spec.mjs, here and in .env.prod.tpl.
# A preview-only variable gets `appliesTo: ['preview']` in the spec instead.
#
# Never write a 1Password reference in a comment: `op inject` resolves those too.
#
# Full guide: docs/ENVIRONMENT.md

# -- Toggl --------------------------------------------------------------------
# Personal token from https://track.toggl.com/profile (bottom of the page).
# Set, the server holds the token like production and Settings hides the token
# field. Blank it to work on the bring-your-own-token path instead.

TOGGL_API_TOKEN=op://Development/toggl-track-quick-view-dev/TOGGL_API_TOKEN

# Slower than production's 170s. Toggl's Free plan allows 30 requests/hour per
# account, and production polls the same account; 600s costs 6 requests/hour.
# Lower it when working on data, but the two budgets add up. Blank is worse:
# without the shared cache every browser refresh is an upstream request.

TOGGL_CACHE_INTERVAL=600

# -- Access -------------------------------------------------------------------
# Blank locally: the gate is off. Set it together with the MongoDB block below
# to work on settings sync or standalone mode; those routes write and require a
# password, so `pnpm env:check` fails on one without the other. Any value works,
# e.g. `localdev`.

APP_PASSWORD=

# -- Settings sync / standalone mode (opt-in) ---------------------------------
# Uncomment all three lines and set APP_PASSWORD to run what production runs:
# Toggl as the source, MongoDB (the local Docker container) for settings sync.
#
#   APP_MODE=toggl
#   MONGODB_URI=mongodb://localhost:27018/toggl-quick-view
#   MONGODB_DB=toggl-quick-view
#
# Leave out APP_MODE for standalone mode: the app serves its own store and
# never contacts Toggl. See README.md.
#
# Keep the connection string a local literal so the default can never reach
# production.

# -- PDF template pack --------------------------------------------------------
# Private repository with the engagement-specific PDF templates, checked out
# into pdf-templates/ before `pnpm dev` and `pnpm build`. Blank it if you have
# no access: the app then offers only its generic Timesheet template.
#
# Blanking it keeps a pack already on disk; `rm -rf pdf-templates` removes it.
# ssh here (your own key), https in deployments. Offline, the existing checkout
# is kept.

PDF_TEMPLATE_PACK_REPO=git@github.com:vojtechzicha/toggl-track-quick-view-pdf-templates.git

# Branch, tag or commit. Blank means main.

PDF_TEMPLATE_PACK_REF=

# -- Signing ------------------------------------------------------------------
# RFC 3161 timestamp authority, proxied by /api/timestamp. Set, signed PDF
# exports are PAdES-B-T instead of B-B and keep verifying after the signing
# certificate expires. Only a hash is sent.
#
# Blank locally: no third party is contacted. Free authorities for testing:
# http://timestamp.digicert.com, http://freetsa.org/tsr. Neither is on the EU
# Trust List, so the EU DSS validator reports them as INDETERMINATE (Adobe
# accepts them). See docs/pdf-signing-v2.md.

TSA_URL=

# HTTP Basic credentials (user:password) for a commercial authority. Ignored
# without TSA_URL.

TSA_CREDENTIALS=
