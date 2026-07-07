# Phases 2 + 3 — Standalone backend and the tracker UI

Prerequisite: Phase 1 (the `TrackBackend` abstraction) is merged.

---

# Phase 2 — MongoDB backend + store API

**Goal:** a complete server-side store with the same read contract as the Toggl
proxy, plus write endpoints. Fully testable with `curl` before any UI exists.

## Mode detection

- `MONGODB_URI` set → `/api/config` returns `mode: 'standalone'`.
- Standalone mode **requires** `APP_PASSWORD` (the store routes mutate data);
  if it is missing, `/api/config` reports a misconfiguration and the store
  routes refuse with 500.
- `TOGGL_API_TOKEN` / `TOGGL_CACHE_INTERVAL` are ignored in standalone mode
  (the Toggl proxy stays functional for the Phase 5 importer, which brings a
  browser token).

## Connection helper — `lib/store/mongo.ts`

Standard serverless pattern: a module-level cached `MongoClient` promise
(survives warm lambda invocations, avoids connection storms). Database name
from `MONGODB_DB`, default `toggl-quick-view`.

## Data model

```
workspaces: {
  _id: ObjectId,
  numericId: number,          // small, stable; from a counters collection
  name: string,
  color?: string,             // hex, shown in chips exactly like Toggl colors
  settings: PresetValue,      // the same shape presets snapshot today
  createdAt: Date,
}

entries: {
  _id: ObjectId,
  numericId: number,          // TimeEntry.id is a number — see counters
  workspaceId: number,        // → workspaces.numericId
  description: string,
  start: Date,                // UTC
  stop: Date | null,          // null = running
  tags: string[],             // billing tag included here, same as Toggl
  togglId?: number,           // set by the importer; enables idempotent re-runs
  createdAt: Date,
  updatedAt: Date,
}

counters: { _id: 'workspaces' | 'entries', seq: number }   // findOneAndUpdate $inc
```

Indexes:

- `entries`: `{ workspaceId: 1, start: -1 }` (range queries),
  `{ numericId: 1 }` unique,
  `{ stop: 1 }` **partial unique on `{stop: null}`** — at most one running
  timer, enforced by the database so two devices cannot race,
  `{ togglId: 1 }` unique + sparse (importer dedupe).
- `workspaces`: `{ numericId: 1 }` unique.

## Serialization to `TimeEntry`

The store API speaks the exact shape `lib/calc.ts` already consumes:

```ts
{
  id: e.numericId,
  start: e.start.toISOString(),
  stop: e.stop ? e.stop.toISOString() : null,
  duration: e.stop ? (e.stop - e.start) / 1000
                   : -Math.floor(e.start / 1000),   // Toggl running convention
  project_id: e.workspaceId,        // ← the workspace-is-a-project trick
  workspace_id: 1,                  // constant; nothing reads it downstream
  description: e.description,
  tags: e.tags,
}
```

`normalize()` treats `stop: null` / negative duration as "running, clamp to
now" — the dashboard's live ring, break reminder and streak logic work with no
changes.

## API routes (all behind the `APP_PASSWORD` gate via `lib/serverAuth.ts`)

| Route | Behavior |
|---|---|
| `GET /api/store/entries?start_date&end_date` | Entries overlapping the range, **across all workspaces** (the client filters by `ProjectSet`, and linked workspaces need one another's entries — same as Toggl returns all projects' entries today). |
| `POST /api/store/entries` | Create. Body: description, workspaceId, tags, start, stop (`null` starts a timer). Starting a timer first stops any running entry (sets its stop = new start), Toggl semantics. |
| `PATCH /api/store/entries/:id` | Partial update: description, tags, start, stop, workspaceId. |
| `DELETE /api/store/entries/:id` | Delete. |
| `POST /api/store/entries/:id/stop` | Stop the running entry (stop = now). 409 if not running. |
| `GET /api/store/tags?q=&prefix=` | Tag autocomplete: aggregation — unwind tags, filter by prefix/substring, group with `max(start)`, sort by recency, limit 20. |
| `GET/POST /api/store/workspaces`, `PATCH/DELETE /api/store/workspaces/:id` | Workspace CRUD. Delete requires the workspace to have no entries (or takes `?force=1` to cascade). |

Every mutation returns the canonical serialized entry so the client can update
its cache without a refetch.

## Client backend — `lib/source/standalone.ts`

Implements `TrackBackend`:

- `mode: 'standalone'`, `hourlyRequestLimit: null` (meter goes dormant).
- `connect()` → `GET /api/store/workspaces`, mapped to `ConnectInfo`
  (`projects` = workspaces with their numericId/name/color; `accountName` from
  a future profile setting or blank).
- `fetchEntries()` → `GET /api/store/entries`.
- Plus mutation methods used only by the tracker UI (not part of the read
  contract): `createEntry`, `updateEntry`, `deleteEntry`, `stopEntry`,
  `suggestTags`.

`useTrackSource` picks the backend from `AppConfig.mode` once config resolves.
Standalone polling: fixed ~30s interval (no budget constraints), instant
refetch after any mutation, and the Toggl-specific UI (token field, request
meter, refresh picker) is hidden when `mode === 'standalone'`.

**Acceptance:** with `MONGODB_URI` + `APP_PASSWORD` set, the existing dashboard
and timesheet render real data created via `curl` — before any tracker UI
exists.

---

# Phase 3 — The tracker UI

**Goal:** a `/tracker` page replicating the Toggl Track timer view, feature-for-
feature with what is actually used: entry list, description editing, billing
tag with autocomplete, start/end date-times, add-at-top, running timer.

## Page layout (`app/tracker/page.tsx` + `components/tracker/*`)

1. **Add bar (top, sticky)**
   - Description input.
   - **Billing-tag combobox** with autocomplete (`TagCombobox`): prefix-aware
     suggestions from `/api/store/tags`, ordered by recency; free text creates
     a new tag; Enter accepts, Esc dismisses.
   - Workspace selector (defaults to the active workspace; hidden when only
     one exists).
   - Mode toggle: **timer** (big Start button → the bar becomes the running
     strip: live `H:MM:SS`, description/tag editable in place, Stop button) or
     **manual** (start & end datetime-local inputs → Add button).
2. **Entry list**, newest first, grouped by day:
   - Day header: weekday + date, day total.
   - Row: description (click to edit inline), tag chip (click opens the
     combobox), `start – stop` times (click opens a small popover with two
     datetime-local inputs), duration, **continue ▶** (starts a new running
     entry copying description/tag/workspace), delete (with confirm).
   - The running entry renders pinned at the top of today with a live
     duration.
   - Week header with the week total (Saturday-start weeks, same as
     everywhere else in the app).
3. Navigation: topbar links Dashboard ⇄ Timesheet ⇄ Tracker (Tracker link only
   in standalone mode).

## State & data flow

- The page consumes `useTrackSource` like the others (same fetch cadence — one
  poll shared app-wide) plus the standalone mutation methods.
- **Optimistic updates**: mutations update local entry state immediately and
  reconcile with the server response; errors roll back and surface a toast.
- Edits to the running entry's start time keep it running (stop stays null).

## Workspaces absorb presets (standalone mode)

- The Settings "Workspaces" section reads/writes the server list instead of
  localStorage presets: recall = switch the active workspace (persist its
  `settings` into the local form), ↻ re-captures current settings into the
  workspace document, rename/delete call the API.
- `selectedProjects` for a workspace defaults to `[its own numericId]`;
  selecting several workspaces pools them exactly like multi-project tracking
  does today.
- Device-local knobs (refresh interval) stay in localStorage; everything else
  gains cross-device sync for free.

**Acceptance:** track a full day (timer + manual entries + edits) on `/tracker`
and see the dashboard ring, break reminder, timesheet and exports behave
identically to Toggl mode.
