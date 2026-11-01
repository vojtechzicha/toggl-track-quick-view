# Claude connector (remote MCP)

The app serves a remote [MCP](https://modelcontextprotocol.io) server at
`/api/mcp`. Add it to Claude once, and every Claude session (claude.ai chat,
Claude Code in any repository, desktop, mobile) can read the Toggl account
behind the dashboard, check timesheets exactly as the app computes them, and
create or update time entries.

It needs `MONGODB_URI` and `APP_PASSWORD`: the database holds the OAuth clients,
grants, tokens, the audit log and a small Toggl cache, and approving a
connection takes the app password. The tools use the server's
`TOGGL_API_TOKEN`.

## Connect

**claude.ai** (also covers the desktop and mobile apps and Claude Code cloud
sessions): Settings → Connectors → Add custom connector, URL
`https://track.zicha.dev/api/mcp`. Claude opens the app's consent page; enter
the app password, choose "Read and write entries" or "Read only", and allow.

**Claude Code in a terminal:**

```bash
claude mcp add --transport http --scope user toggl-quick-view https://track.zicha.dev/api/mcp
```

Then run `/mcp` in Claude Code and authenticate.

**Settings → Claude connector** in the app shows the address, copies that
command, and lists every connected app with Disconnect.

## Tools

| Tool | Toggl requests | What it does |
| --- | --- | --- |
| `get_context` | 0, or 1 with `refresh` (cached a day) | Account, projects, tags, stored workspaces (timesheet setups), time zone, last known quota |
| `list_time_entries` | 1 per range (cached 2 min) | Entries between two local dates, with hours per day and per Saturday–Friday week |
| `get_timesheet` | 1 per range (cached 2 min) | A stored workspace's timesheet as the Timesheet page and exports compute it, plus its checks; `format: "csv"` adds the CSV export |
| `create_time_entries` | 1 to read the week, then 1 per entry | Up to 50 entries; validated first, duplicates skipped, overlaps reported, `dry_run` |
| `update_time_entries` | 1 per changed entry (+1 to read one not recently listed) | Time, description, project, tags (`tags` replaces, `add_tags`/`remove_tags` edit), `dry_run` |
| `list_recent_changes` | 0 | The audit log: each written entry before and after |

Times are local wall times (`2026-10-30T09:15`) in `APP_TIME_ZONE` (default
Europe/Prague), or ISO strings with an offset. Weeks run Saturday to Friday, as
everywhere in the app.

**Verifying.** `get_timesheet` takes a stored workspace (name or id; default
the active settings, as last synced) and builds the timesheet with the same
code as the screen: `buildExportDoc` for the billed figures and
`buildIndividualWeek` for the checks. `checks` lists entries without a billing
tag, with several, too long to bill alone, and overlaps, with the minutes and
description of each, plus time trimmed by Don't bill overtime, time moved by
Balance working days, and holidays. `ok` is true when there are no warnings or
overlaps. The workspace settings come from the settings-sync document, so a
change made on a device reaches the tools once that device has synced.

**Exports.** CSV comes back from `get_timesheet`. XLSX and PDF, and PDF signing
with the smart card, stay in the app, because signing needs the card reader
next to the browser.

**Not here:** deleting entries, starting or stopping timers, and creating
projects or tags (an unknown tag fails the batch unless `allow_new_tags` is
set, because it is usually a typo).

## The Toggl quota

Toggl's Free plan allows 30 requests an hour per bucket, and the dashboard,
local development and the connector all spend the same account's budget. The
tools are built around that:

- Reads are cached in the database (`toggl_cache`): the account for a day,
  entry ranges for two minutes. A second look at the same week is free.
- Every Toggl response's `X-Toggl-Quota-Remaining` / `-Resets-In` headers are
  recorded per bucket (`toggl_quota`), including the dashboard proxy's, so all
  instances share one picture. `get_context` shows it.
- Writes stop while 5 requests are left (kept for the dashboard), or when Toggl
  answers 402/429, and the result lists `not_created` / `not_updated` with the
  reset time. Re-sending the same batch then is safe: an entry already in Toggl
  with the same start minute, project and description is skipped.
- Writes are spaced one second apart (Toggl's per-IP safeguard), and a call
  stops starting new writes after 40 seconds, inside the function's 60-second
  limit. About 25 entries fit in one hour's budget.

Toggl documents a per-user bucket (`/me` endpoints) and a per-user-per-
organization bucket (workspace endpoints, where writes go), but not which one
`/me/time_entries` uses. The recorded snapshots will show it.

## Safety

- **Audit log.** Every write is stored in `mcp_audit` with the entry before and
  after. `list_recent_changes` reads it; use it to review or undo.
- **Who.** Whoever knows `APP_PASSWORD` can approve a connection. The consent
  page throttles wrong guesses like the password gate. Grants remember a
  fingerprint of the password, so rotating `APP_PASSWORD` disconnects every app,
  as it ends every browser session.
- **Scopes.** `timesheet:read`, or `timesheet:read timesheet:write`, chosen on
  the consent page. Read-only connections don't see the write tools.
- **Tokens.** Access tokens last 1 hour, refresh tokens 60 days and rotate on
  every use; reusing an old refresh token revokes the whole connection. Codes
  and tokens are stored only as SHA-256 hashes, and TTL indexes prune them.
  Tokens are bound to the origin that issued them, so a production token does
  not work on a preview deployment.
- **Redirects.** Clients may only register Claude's callbacks
  (`https://claude.ai/api/mcp/auth_callback`,
  `https://claude.com/api/mcp/auth_callback`) and loopback addresses (Claude
  Code). `MCP_EXTRA_REDIRECT_URIS` adds more.
- **Never returned:** the Toggl token and the export identity details
  (company, rate, signature image) of the stored workspaces.

## How it works

```
Claude ── POST /api/mcp (Bearer) ──▶ app/api/mcp/route.ts ─▶ lib/mcp/server.ts ─▶ lib/mcp/tools/* ─▶ lib/toggl/server.ts ─▶ Toggl
   │ 401 + resource_metadata
   ├─▶ /.well-known/oauth-protected-resource/api/mcp   (RFC 9728)
   ├─▶ /.well-known/oauth-authorization-server         (RFC 8414)
   ├─▶ POST /api/mcp/oauth/register                    (dynamic client registration, RFC 7591)
   ├─▶ /oauth/authorize                                (app password + consent, PKCE S256)
   ├─▶ POST /api/mcp/oauth/token                       (authorization_code, refresh_token)
   └─▶ POST /api/mcp/oauth/revoke                      (RFC 7009)
```

- `lib/mcp/oauth.ts`: authorization server. Ported from zicha-study and
  szz-flashcards.
- `lib/mcp/store.ts`: `mcp_clients`, `mcp_auth_codes`, `mcp_grants`,
  `mcp_tokens`, `mcp_audit`, and an in-memory store for the checks.
- `lib/mcp/tool-kit.ts`: tool definition, scope filtering, error mapping,
  audit.
- `lib/mcp/entries.ts`, `lib/mcp/time.ts`, `lib/mcp/timesheet.ts`: the pure
  parts (resolving projects and tags, planning a batch, local time, the
  timesheet).
- `lib/toggl/server.ts`: the server-side Toggl client, quota recording and the
  cache.
- `app/api/mcp/connections`: the list and Disconnect in Settings.

The endpoint is stateless (a new MCP server per request, JSON responses),
which fits Vercel functions. The issuer and resource URLs come from the request
host; set `MCP_PUBLIC_URL` if a proxy hides it. The route sets the process time
zone to `APP_TIME_ZONE`, because the timesheet builders work in local time and
Vercel functions run in UTC.

## Testing locally

```bash
# .env: uncomment the MongoDB block and set APP_PASSWORD
pnpm dev
npx @modelcontextprotocol/inspector
```

In the Inspector, connect to `http://localhost:3000/api/mcp` with Streamable
HTTP. Its callback is a loopback address, so it registers without extra
configuration. Local development spends the same Toggl budget as production.

`pnpm check:mcp` runs without network or database: the OAuth flow against the
in-memory store, local times across both DST changes, tag and project
resolution, batch planning (duplicates, overlaps, validation), and the
timesheet against the export builder.
