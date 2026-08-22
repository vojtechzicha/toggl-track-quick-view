# =============================================================================
# PRODUCTION configuration — the reference copy of what Vercel should hold.
#
#   pnpm env:pull:prod   writes .env.prod from this file via `op inject`
#
# Vercel remains the source of truth for the running deployment; this file
# exists so the values are recoverable, diffable, and ready if the hosting or a
# service ever changes. .env.prod is gitignored and holds LIVE production
# secrets — generate it when you need it, delete it when you are done.
#
# It is NOT loaded by anything automatically. Nothing reads .env.prod unless
# you point a command at it explicitly.
#
# PREVIEW deployments are a third environment with no template of their own:
# Vercel holds those values and 1Password mirrors them in the
# toggl-track-quick-view-preview item. The differences are listed in
# docs/ENVIRONMENT.md.
#
# Full walkthrough, including the 1Password layout: docs/ENVIRONMENT.md
# =============================================================================

# -- Track source -------------------------------------------------------------
# Production is a TOGGL-mode deployment that also syncs settings across devices.
# APP_MODE=toggl is load-bearing, not decoration: delete this row in Vercel and
# the next deploy silently becomes a standalone app serving an empty MongoDB
# store instead of your Toggl data. scripts/env-spec.mjs marks it required in
# production for exactly that reason.

APP_MODE=toggl

# -- Toggl --------------------------------------------------------------------

TOGGL_API_TOKEN=op://Development/toggl-track-quick-view-prod/TOGGL_API_TOKEN

# 170s ≈ 21 upstream requests/hour, under Toggl's Free-plan 30/hour and with
# room for the one-off connect calls. This is also what makes the per-device
# "Refresh interval" picker disappear from Settings: with a shared server cache
# every viewer is the same user looking at the same data, so one cadence serves
# them all.

TOGGL_CACHE_INTERVAL=170

# -- Database -----------------------------------------------------------------
# MongoDB Atlas. Alongside APP_MODE=toggl this backs settings sync only — the
# time entries themselves still come from Toggl.

MONGODB_URI=op://Development/toggl-track-quick-view-prod/MONGODB_URI

# NOT set in Vercel, so production uses the "toggl-quick-view" default from
# lib/store/mongo.ts. Left empty here to match, because the alternative is
# worse: filling it in would document a database production is not using.
#
# Worth knowing when you go looking for the data — the Atlas cluster and the
# database in the connection string path are both named timetrack-quick-view,
# but the code always passes an explicit name, so the path is ignored and the
# live sync documents sit in toggl-quick-view.

MONGODB_DB=

# -- Access -------------------------------------------------------------------
# The only thing between the public internet and the time entries: production
# holds the Toggl token itself, so without this the dashboard is readable by
# anyone who knows the URL.
#
# The HMAC signing key is derived FROM this password, so changing it instantly
# invalidates every 7-day session and every device is asked again.

APP_PASSWORD=op://Development/toggl-track-quick-view-prod/APP_PASSWORD
