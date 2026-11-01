// Contract between the UI and its time-entry source, the Toggl API (via the
// proxy). Everything downstream consumes TimeEntry, so a source only
// implements connect and fetchEntries.

import type { TimeEntry } from '@/lib/calc';

/** Something to track against: a Toggl project. */
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
  /** Changes in the server's local copy not yet in Toggl (mirror only). */
  pending?: number;
}

export interface TrackBackend {
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
