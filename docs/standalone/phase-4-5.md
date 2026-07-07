# Phases 4 + 5 — Linked workspaces and the Toggl importer

Prerequisites: Phases 1–3 (standalone mode fully usable for day-to-day
tracking).

**Status: implemented in this branch.** Decisions taken during implementation
(confirmed with the owner):

- **Running Toggl entries import as stopped at import time** (owner's pick of
  the two options below) — never as running, so imported history can't fight
  the store's single-running-timer invariant.
- **Re-runs never overwrite**: a `togglId` already in the store is skipped, so
  local edits made after an import always win over a re-run.
- **Archived projects**: history references projects the (active-only)
  projects API no longer returns, so the mapping table has a catch-all "any
  other project" row besides the plan's explicit "(no project)" row; both
  default to skip. Mapping keys: the project id, `'0'` (no project),
  `'*'` (catch-all).
- **"Create new" is re-run safe**: before creating, the importer reuses an
  existing workspace with the same name (and pins the row's choice to it), so
  an interrupted import re-run doesn't spawn duplicate workspaces.
- **Linked-workspace picker**: the dropdown offers every workspace except the
  active one (the one whose settings the form mirrors); picking one auto-adds
  it to the tracked set — the standalone form of "a mapped project must be
  among the selected projects".
- **Delete guard**: the client warns (with the referencing workspaces named)
  before deleting a workspace that others link or track; the server strips the
  dangling `codeMappings`/`selectedProjects` references from the surviving
  documents (and the device's own local settings) either way.

---

# Phase 4 — Linked workspaces

**Goal:** the "linked billing codes" concept (`lib/timesheet/mapping.ts`)
survives without Toggl projects: a sub-client **workspace** bills onto another
workspace's timesheet as a single code, on its own tag prefix, rounding grid
and overtime rules.

## Why this is nearly free

`CodeMapping.projectId` is just a number, and in standalone mode a workspace's
`numericId` **is** the project id on every entry (see phase-2-3.md). The whole
mapping engine — per-day rounding on the mapping's grid, the sub-client's own
no-overtime trim, the per-day sum invariant — runs unchanged. Only selection
UI and data loading need work:

1. **Settings picker** (`SettingsPanel.tsx`): in standalone mode the "Linked
   billing codes" project dropdown lists *other workspaces* (excluding the
   active one), sourced from the same `ConnectInfo.projects` list the normal
   picker uses. The tag prefix / rounding / target code / no-overtime fields
   are unchanged.
2. **Selection semantics**: mapping a workspace implies its entries must be in
   the tracked set — exactly like today, where a mapped project must be among
   `selectedProjects`. The picker enforces it the same way.
3. **Entry loading**: already handled — `GET /api/store/entries` returns all
   workspaces' entries in range (Phase 2 decision), so the timesheet builders
   see the linked workspace's entries just as they saw the linked Toggl
   project's.
4. **Cross-workspace settings integrity**: deleting a workspace that another
   workspace's `codeMappings` references gets a guard (warn + strip the
   mapping), server-side on delete.

**Acceptance:** reproduce the current subcontracting setup with two standalone
workspaces — the prime timesheet shows the sub-client's day totals as one code,
equal cell-for-cell to the sub-client workspace's own timesheet, including its
no-overtime trim.

---

# Phase 5 — Toggl history importer

**Goal:** one-off (re-runnable) migration of Toggl history into the standalone
store so timesheets and exports keep their history. This is why Toggl mode and
the proxy stay in the codebase until after migration.

## Design

A dedicated screen (`/import`, standalone mode only):

1. **Connect to Toggl** with a browser-entered API token (the existing proxy
   and `togglBackend.connect()` — no new Toggl code).
2. **Map projects → workspaces**: table of Toggl projects with a workspace
   dropdown per row (existing workspace, "create new" prefilled with the
   project's name/color, or "skip"). Unassigned entries (no project) get an
   explicit choice too.
3. **Pick a date range** (default: everything until today).
4. **Run**: page through `getEntries` in ~90-day windows, oldest first,
   respecting the Toggl budget meter (30 req/h — show progress and auto-pause
   on rate limit, exactly like the poll's backoff). Each window is POSTed to a
   bulk endpoint.

## Bulk endpoint

`POST /api/store/import` — body: `{ entries: [...], mapping: {togglProjectId → workspaceId} }`.

- Inserts with `togglId` set; the sparse unique index makes re-runs
  **idempotent** (duplicate `togglId` → upsert/skip), so an interrupted import
  is simply run again.
- Running Toggl entries are imported as stopped at import time or skipped
  (imported history should not fight the local running-timer invariant).
- Tags and descriptions copy verbatim — billing-tag prefixes, "(X)" overtime
  markers and linked-code tags all keep working because the timesheet logic
  only ever looked at strings.

## After migration (cleanup, separate PR)

- Optionally delete Toggl mode: `lib/source/toggl.ts`, the proxy route,
  `lib/serverCache.ts`, the token UI in Settings, the request-budget meter,
  and `TOGGL_*` env handling. The `TrackBackend` abstraction stays (it is the
  seam that made all of this possible, and would host any future source).
- Update README for standalone-first documentation.

**Acceptance:** a real Toggl account's full history imports into mapped
workspaces; a historical week's timesheet and PDF export match what Toggl mode
produced for the same week; re-running the import creates no duplicates.
