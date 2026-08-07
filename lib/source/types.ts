// Provider-agnostic contract between the UI and a time-entry source.
//
// The app can read time entries from more than one kind of backend ("source"):
// the original Toggl Track API (via the same-origin proxy) and — in standalone
// mode — the app's own MongoDB-backed store. Everything downstream of data
// fetching (calc, the timesheet builders, exports, the pages) consumes the
// same TimeEntry shape, so a source only has to answer two questions: "who am
// I / what can I track?" (connect) and "which entries overlap this range?"
// (fetchEntries).

import type { TimeEntry } from '@/lib/calc';

/** Which kind of backend serves the data. */
export type SourceMode = 'toggl' | 'standalone';

/**
 * Something the user can select to track against. In Toggl mode this is a
 * Toggl project; in standalone mode it is a stored workspace (each workspace
 * acts as its own "project", carrying the same numeric-id contract so
 * ProjectSet / selectedProjects / codeMappings work unchanged).
 */
export interface TrackProject {
  id: number;
  name: string;
  active?: boolean;
  color?: string;
}

/** What a successful connect resolves: the account and its selectable projects. */
export interface ConnectInfo {
  workspaceId: number;
  accountName: string;
  /** Active projects, sorted by name — ready for the Settings picker. */
  projects: TrackProject[];
}

/** A fetched entry set together with how fresh it actually is. */
export interface FetchedEntries {
  entries: TimeEntry[];
  /**
   * When the SOURCE produced this data (ms epoch), not when this client
   * received it. The difference matters on the Toggl path with the shared
   * server cache: a cache hit reports the original upstream fetch time, so
   * the UI can show true data age. The standalone store reads live on every
   * call (no cache layer), so there its fetch time is the data time. Null
   * when the transport didn't say (e.g. an older server without the header);
   * callers fall back to the receipt time.
   */
  dataAtMs: number | null;
}

export interface TrackBackend {
  readonly mode: SourceMode;
  /**
   * The client-side requests-per-hour budget to meter against, or null when
   * the source is unmetered (our own store). Toggl Free allows 30/hour.
   */
  readonly hourlyRequestLimit: number | null;
  /** Verify credentials and resolve the account + project list. */
  connect(token: string): Promise<ConnectInfo>;
  /**
   * Raw time entries overlapping [startISO, endISO). `force` asks the server
   * to bypass any shared response cache (a manual refresh).
   */
  fetchEntries(
    token: string,
    startISO: string,
    endISO: string,
    opts?: { force?: boolean }
  ): Promise<FetchedEntries>;
}
