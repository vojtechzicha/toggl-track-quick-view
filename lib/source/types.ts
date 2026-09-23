// Contract between the UI and a time-entry source: the Toggl API (via the
// proxy) or the standalone MongoDB store. Everything downstream consumes
// TimeEntry, so a source only implements connect and fetchEntries.

import type { TimeEntry } from '@/lib/calc';

/** Which kind of backend serves the data. */
export type SourceMode = 'toggl' | 'standalone';

/**
 * Something to track against: a Toggl project, or in standalone mode a stored
 * workspace (same numeric-id contract, so selectedProjects and codeMappings
 * work unchanged).
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

/** Fetched entries and how fresh they are. */
export interface FetchedEntries {
  entries: TimeEntry[];
  /**
   * When the source produced this data (ms epoch). A server-cache hit reports
   * the original Toggl fetch time. Null when unknown; callers fall back to
   * receipt time.
   */
  dataAtMs: number | null;
}

export interface TrackBackend {
  readonly mode: SourceMode;
  /** Requests-per-hour budget to meter against; null when unmetered. */
  readonly hourlyRequestLimit: number | null;
  /** Verify credentials and resolve the account + project list. */
  connect(token: string): Promise<ConnectInfo>;
  /** Time entries overlapping [startISO, endISO). `force` bypasses the server cache. */
  fetchEntries(
    token: string,
    startISO: string,
    endISO: string,
    opts?: { force?: boolean }
  ): Promise<FetchedEntries>;
}
