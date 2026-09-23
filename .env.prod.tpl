# Production config: the reference copy of what Vercel holds.
#
#   pnpm env:pull:prod   writes .env.prod from this file via `op inject`
#
# Vercel is the source of truth; this file keeps the values recoverable and
# diffable. .env.prod is gitignored, holds live secrets and is loaded by
# nothing. Delete it when done.
#
# Preview has no template: Vercel holds its values and the 1Password item
# toggl-track-quick-view-preview mirrors them.
#
# Never write a 1Password reference in a comment: `op inject` resolves those too.
#
# Full guide: docs/ENVIRONMENT.md

# -- Track source -------------------------------------------------------------
# Keeps Toggl as the source while MONGODB_URI is set. Without it production
# would switch to standalone mode and serve an empty store, so the spec marks
# it required.

APP_MODE=toggl

# -- Toggl --------------------------------------------------------------------

TOGGL_API_TOKEN=op://Development/toggl-track-quick-view-prod/TOGGL_API_TOKEN

# 170s is about 21 requests/hour, under the Free plan's 30 with room for other
# calls. While set, Settings hides the per-device "Refresh interval" picker.

TOGGL_CACHE_INTERVAL=170

# -- Database -----------------------------------------------------------------
# MongoDB Atlas. With APP_MODE=toggl it holds synced settings only.

MONGODB_URI=op://Development/toggl-track-quick-view-prod/MONGODB_URI

# Not set in Vercel, so production uses the "toggl-quick-view" default from
# lib/store/mongo.ts. The database in the connection-string path
# (timetrack-quick-view) is ignored.

MONGODB_DB=

# -- Access -------------------------------------------------------------------
# Required: the server holds the Toggl token, so without it anyone with the URL
# can read the time entries. The session signing key is derived from it, so
# changing it logs out every device.

APP_PASSWORD=op://Development/toggl-track-quick-view-prod/APP_PASSWORD

# -- PDF template pack --------------------------------------------------------
# The PDF templates in actual use come from this private repository. Without it
# the build still succeeds but offers only the generic Timesheet, so the spec
# marks it required. https because a Vercel build has no ssh key. If the
# checkout fails, the build fails.

PDF_TEMPLATE_PACK_REPO=https://github.com/vojtechzicha/toggl-track-quick-view-pdf-templates.git

# Blank means main. Pin a commit if pack changes should not reach the next
# deployment on their own.

PDF_TEMPLATE_PACK_REF=

# GitHub fine-grained PAT, Contents: Read on that one repository. Sensitive in
# Vercel. When it expires, builds fail at the checkout with a 403.

PDF_TEMPLATE_PACK_TOKEN=op://Development/toggl-track-quick-view-prod/PDF_TEMPLATE_PACK_TOKEN

# -- Signing ------------------------------------------------------------------
# RFC 3161 timestamp authority, proxied by /api/timestamp. Set, signed PDF
# exports are PAdES-B-T instead of B-B and keep verifying after the signing
# certificate expires.
#
# Blank until qualified timestamps are bought. The EU DSS validator trusts only
# authorities on the EU Trust List, and reports free ones (DigiCert,
# freetsa.org) as INDETERMINATE. I.CA and PostSignum sell qualified timestamps;
# setting this variable is the only change needed. See docs/pdf-signing-v2.md.

TSA_URL=

# HTTP Basic credentials (user:password), if the authority needs them.
# Sensitive in Vercel.

TSA_CREDENTIALS=
