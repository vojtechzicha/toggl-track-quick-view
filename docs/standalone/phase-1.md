# Phase 1 — Extract the track-source abstraction

**Goal:** make the data layer pluggable without changing any behavior. After
this phase the app works exactly as before (Toggl only), but the UI no longer
imports Toggl specifics directly — it talks to a `TrackBackend`, so Phase 2 can
add a standalone backend without touching the dashboard, timesheet, or exports.

**Status: implemented in this branch.**

## New module layout

`lib/toggl.ts` (a mix of Toggl client, app-gate session, config client and
error types) and `lib/useToggl.ts` are reorganized into:

```
lib/source/
  types.ts     — the provider-agnostic contract (SourceMode, TrackProject,
                 ConnectInfo, TrackBackend)
  errors.ts    — ApiError, AuthRequiredError, isRateLimit(), isAuthRequired()
  auth.ts      — password-gate session (loadAuth/hasValidAuth/clearAuth/login);
                 shared by every backend, both proxies sit behind the same gate
  config.ts    — AppConfig + getConfig(), now including `mode`
  toggl.ts     — the Toggl backend: proxy client (tApi/getMe/getProjects/
                 getEntries), HOURLY_LIMIT, and `togglBackend: TrackBackend`
lib/useTrackSource.ts — the hook, renamed from lib/useToggl.ts; same returned
                 interface (UseTrackSource), now driven by a TrackBackend
```

`lib/toggl.ts` and `lib/useToggl.ts` are deleted. The unused `getCurrent`
helper is dropped in the move (the entries list already includes the running
timer).

## The contract

```ts
export type SourceMode = 'toggl' | 'standalone';

export interface TrackProject {   // Toggl project today; a workspace in Phase 3
  id: number;
  name: string;
  active?: boolean;
  color?: string;
}

export interface ConnectInfo {
  workspaceId: number;
  accountName: string;
  projects: TrackProject[];       // active, sorted by name — picker-ready
}

export interface TrackBackend {
  readonly mode: SourceMode;
  /** Client-side requests/hour budget, or null when unmetered (own store). */
  readonly hourlyRequestLimit: number | null;
  connect(token: string): Promise<ConnectInfo>;
  fetchEntries(token: string, startISO: string, endISO: string,
               opts?: { force?: boolean }): Promise<TimeEntry[]>;
}
```

Design notes:

- `TimeEntry` (`lib/calc.ts`) stays the lingua franca — the backend's job is to
  produce it; nothing downstream changes.
- The account/project sorting and active-filtering move from the hook into the
  Toggl backend's `connect()` — the hook is now backend-neutral.
- The request-budget meter (localStorage reqlog) stays in the hook but is gated
  on `backend.hourlyRequestLimit !== null`, so it goes dormant automatically
  for an unmetered backend.
- The 24h me/projects cache stays in the hook; its shape
  (`{workspaceId, projects, accountName}`) is already provider-neutral.
- Errors generalize: `TogglError` → `ApiError` (status-carrying); the
  UI only ever used the classifiers `isRateLimit`/`isAuthRequired`, which move
  to `lib/source/errors.ts` unchanged in behavior.

## Server-side change

`app/api/config/route.ts` adds `mode: 'toggl'` (hard-coded this phase;
Phase 2 derives it from `MONGODB_URI`). The client `AppConfig` gains the field
with a `'toggl'` fallback so an older server response still parses.

## Import-site updates (the entire blast radius)

| File | Change |
|---|---|
| `app/page.tsx` | `useToggl` → `useTrackSource` (from `@/lib/useTrackSource`); `HOURLY_LIMIT` from `@/lib/source/toggl` |
| `app/timesheet/page.tsx` | same hook rename; `isAuthRequired` from `@/lib/source/errors` |
| `components/SettingsPanel.tsx` | `Project` type → `TrackProject` from `@/lib/source/types` |
| `components/export/ExportDialog.tsx` | `isRateLimit`/`isAuthRequired` from `@/lib/source/errors` |

## Acceptance criteria

- `npm run build` and `npm run lint` pass.
- No behavioral change: connect flow, cache-first reconnect, polling cadence,
  backoff, password gate, request meter, presets — all identical (verified by
  the return shape of the hook being unchanged field-for-field).
- No file outside the table above and the `lib/` reorganization is touched.
