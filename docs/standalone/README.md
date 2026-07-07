# Standalone mode — removing the Toggl dependency

This document set plans the addition of a **standalone mode**: the app keeps its
own store of time entries (MongoDB Atlas) instead of reading them from the Toggl
Track API. It is split into three implementation plans:

- [`phase-1.md`](./phase-1.md) — extract a provider-agnostic *track source*
  abstraction (pure refactor, no behavior change).
- [`phase-2-3.md`](./phase-2-3.md) — the MongoDB backend + API routes, and the
  new Toggl-like tracker UI.
- [`phase-4-5.md`](./phase-4-5.md) — linked workspaces (the successor of linked
  billing codes) and the Toggl history importer.

## Why this is doable: the app is already 80% Toggl-independent

The single most important fact about the codebase: **everything downstream of
data fetching consumes one plain data shape, `TimeEntry`** (`lib/calc.ts` — id,
start, stop, duration, project_id, tags, description). The Toggl coupling is
confined to ~900 of the ~3,800 lines:

| Toggl-coupled | Untouched (pure functions over `TimeEntry[]`) |
|---|---|
| `lib/toggl.ts` (API client) | `lib/calc.ts` — targets, ring, breaks, gaps |
| `lib/useToggl.ts` (connect + poll) | `lib/timesheet/*` — summary, individual, overtime, **mapping** |
| `app/api/toggl/[...path]` (proxy) | `lib/export/*` — CSV/XLSX/PDF |
| `lib/serverCache.ts` (rate-limit workaround) | Dashboard math, timesheet grids, ProgressRing |
| Settings project picker | Auth gate (`lib/serverAuth.ts`) — reused as-is |

Even the running timer needs no special handling: `normalize()` already treats
`stop: null` / negative duration as "running, clamp to now" — the standalone
store returns the running entry the same way Toggl does. And the rate-limit
machinery (30 req/hr budget, backoff, server cache) simply goes dormant — our
own MongoDB has no such limit.

## The key design move: a Workspace *is* a project

Today a "workspace" is a localStorage preset, and entries are distinguished by
Toggl `project_id`. In standalone mode:

- **Workspaces become first-class documents in MongoDB**, each owning its
  settings snapshot *and* its time entries. Every workspace gets a small stable
  numeric id.
- **Entries carry that numeric id in the `project_id` slot** when served to the
  client.

That one trick means `ProjectSet`, `selectedProjects`, and — crucially —
**`CodeMapping.projectId` keep working unchanged**. "Linked projects across
workspaces" survive naturally, and actually get *cleaner*: instead of "a Toggl
project that represents the sub-client," the mapping points directly at
**another workspace** — "workspace *Sub-client* bills onto this timesheet as
code D-SUB-1, on its own prefix/grid/overtime rules." All the invariants in
`lib/timesheet/mapping.ts` (per-day sum equality, sub-trim before billing)
transfer with zero logic changes; only the Settings picker swaps "pick a Toggl
project" for "pick a workspace."

## Architecture at a glance

- **Storage**: MongoDB Atlas, official driver, cached connection for Vercel
  serverless. Collections `workspaces` and `entries`; a partial unique index on
  `{stop: null}` guarantees at most one running timer.
- **API**: `app/api/store/*` routes (entries CRUD, stop-timer, tag
  autocomplete, workspaces CRUD), all behind the existing `APP_PASSWORD` gate —
  which becomes **required** in standalone mode, since these are writes.
- **Client**: `/api/config` gains a `mode: 'toggl' | 'standalone'` flag (driven
  by `MONGODB_URI` being set). The polling hook is refactored into
  `useTrackSource` with two backends returning the exact same interface the
  dashboard and timesheet already consume. Standalone polls ~30s plus instant
  refetch after any mutation, with optimistic updates.
- **Tracker UI**: a new `/tracker` page replicating the Toggl Track timer view
  — add bar with description + billing-tag autocomplete, timer/manual modes,
  entry list grouped by day with inline editing, continue and delete.

## Phases (each independently shippable)

1. **Extract the source abstraction** — refactor `useToggl` → `useTrackSource`
   with the Toggl backend behind it. Pure refactor, app behaves identically.
   This de-risks everything after.
2. **Standalone backend** — Mongo connection helper, collections/indexes, CRUD
   routes, mode flag in `/api/config`, workspaces API. Testable with curl
   before any UI exists.
3. **Tracker UI** — the `/tracker` page, plus wiring the standalone backend
   into the dashboard/timesheet (settings picker lists workspaces; presets move
   from localStorage to the workspace documents, which also gets cross-device
   settings sync as a bonus).
4. **Linked workspaces** — mapping picker over workspaces; the mapping engine
   itself is untouched.
5. **Toggl importer** — a one-off import screen that pages history through the
   *existing* proxy (project → workspace of your choosing) into Mongo, so
   timesheets and exports keep their history. This is also why Toggl mode stays
   alive in the code initially — it's already written and it powers the
   migration; it can be deleted in a later cleanup after the switch is
   complete.

## Known trade-offs and risks (all manageable)

- **Toggl's mobile apps and ecosystem are lost** — tracking happens only in
  this app. The PWA shell already exists, so phone use works online; offline
  write-queueing would be a later enhancement, not v1.
- **Multi-device edits** are last-write-wins — fine for a single user; the only
  real race (two running timers) is killed by the unique index.
- **Vercel + Atlas** is a standard pairing (cached client across invocations);
  the free M0 tier is far more than enough for time entries.
- **Timezones**: store UTC `Date`s, render local — exactly what the app does
  today, including the Saturday-start week logic.

## Environment variables (final state)

| Variable | Meaning |
|---|---|
| `MONGODB_URI` | Presence switches the deployment to standalone mode. |
| `MONGODB_DB` | Database name (default `toggl-quick-view`). |
| `APP_PASSWORD` | Required in standalone mode (the store routes are writes). |
| `TOGGL_API_TOKEN` | Toggl mode only (unchanged); also used by the importer. |
| `TOGGL_CACHE_INTERVAL` | Toggl mode only (unchanged). |
