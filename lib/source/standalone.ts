// Standalone source: client for the MongoDB store (app/api/store/...) as a
// TrackBackend, plus the mutation calls used by the tracker and Settings.
//
// Requests carry the password-gate session token, which is mandatory in
// standalone mode. The TrackBackend `token` arguments are ignored.

import type { TimeEntry } from '@/lib/calc';
import type { PresetValue } from '@/components/SettingsPanel';
import { ApiError, AuthRequiredError } from './errors';
import { loadAuth, clearAuth } from './auth';
import type { ConnectInfo, TrackBackend } from './types';

/** A stored workspace as the client sees it (numericId exposed as `id`). */
export interface StoreWorkspace {
  id: number;
  name: string;
  color?: string;
  settings: PresetValue;
  createdAt: string;
}

/** Fields a new/updated entry can carry. Times are ISO strings; stop null = running. */
export interface EntryInput {
  description?: string;
  workspaceId?: number;
  tags?: string[];
  start?: string;
  stop?: string | null;
}

async function sApi<T>(
  path: string,
  opts: { method?: string; body?: unknown; search?: string; keepalive?: boolean } = {}
): Promise<T> {
  const url = `/api/store/${path}${opts.search ? `?${opts.search}` : ''}`;
  const auth = loadAuth();
  const headers: Record<string, string> = {};
  if (auth?.token) headers['x-app-auth'] = auth.token;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
    // Lets a write outlive the page. (sendBeacon cannot send the session header.)
    keepalive: opts.keepalive,
  });
  // Session missing/expired: re-prompt for the password.
  if (res.status === 401 && res.headers.get('x-app-auth') === 'required') {
    clearAuth();
    throw new AuthRequiredError();
  }
  const text = await res.text();
  if (!res.ok) {
    // Store errors carry the cause in `detail` (lib/store/guard.ts); pass it
    // on so database problems are visible in the UI.
    let detail: string | undefined;
    try {
      const body = JSON.parse(text) as { detail?: string; error?: string };
      detail = body.detail ?? body.error;
    } catch {
      /* non-JSON body */
    }
    throw new ApiError(res.status, detail);
  }
  return (text ? JSON.parse(text) : null) as T;
}

// ---- Workspaces ----
export const listWorkspaces = () => sApi<StoreWorkspace[]>('workspaces');

export const createWorkspaceApi = (name: string, settings?: PresetValue, color?: string) =>
  sApi<StoreWorkspace>('workspaces', { method: 'POST', body: { name, settings, color } });

export const updateWorkspaceApi = (
  id: number,
  patch: { name?: string; color?: string; settings?: PresetValue },
  opts?: { keepalive?: boolean }
) =>
  sApi<StoreWorkspace>(`workspaces/${id}`, {
    method: 'PATCH',
    body: patch,
    keepalive: opts?.keepalive,
  });

export const deleteWorkspaceApi = (id: number, force = false) =>
  sApi<{ ok: true; strippedFrom?: string[] }>(`workspaces/${id}`, {
    method: 'DELETE',
    search: force ? 'force=1' : undefined,
  });

// ---- Entries ----
export const fetchStoreEntries = (startISO: string, endISO: string, limit?: number) =>
  sApi<TimeEntry[]>('entries', {
    search:
      `start_date=${encodeURIComponent(startISO)}&end_date=${encodeURIComponent(endISO)}` +
      (limit ? `&limit=${limit}` : ''),
  });

export const createEntryApi = (input: EntryInput) =>
  sApi<TimeEntry>('entries', { method: 'POST', body: input });

export const updateEntryApi = (id: number, patch: EntryInput) =>
  sApi<TimeEntry>(`entries/${id}`, { method: 'PATCH', body: patch });

export const deleteEntryApi = (id: number) =>
  sApi<{ ok: true }>(`entries/${id}`, { method: 'DELETE' });

export const stopEntryApi = (id: number) =>
  sApi<TimeEntry>(`entries/${id}/stop`, { method: 'POST' });

export const suggestTagsApi = (q: string, prefix: string) =>
  sApi<string[]>('tags', {
    search: `q=${encodeURIComponent(q)}&prefix=${encodeURIComponent(prefix)}`,
  });

// ---- Toggl history import (the /import page) ----
/** Counts for one bulk-import batch. */
export interface ImportResult {
  imported: number;
  duplicates: number; // togglId already in the store (re-run) — skipped
  unmapped: number; // project not assigned a workspace — skipped
  invalid: number; // unparseable entry — skipped
  stoppedRunning: number; // running Toggl entries imported as stopped now
}

/**
 * Bulk-insert one window of Toggl entries. `mapping` keys are Toggl project
 * ids, plus '0' (entries without a project) and '*' (any project not listed).
 */
export const importEntriesApi = (entries: TimeEntry[], mapping: Record<string, number>) =>
  sApi<ImportResult>('import', { method: 'POST', body: { entries, mapping } });

/** Map stored workspaces to the picker-ready project list the UI consumes. */
export function workspacesToProjects(ws: StoreWorkspace[]): ConnectInfo['projects'] {
  return ws
    .map((w) => ({ id: w.id, name: w.name, color: w.color }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const standaloneBackend: TrackBackend = {
  mode: 'standalone',
  hourlyRequestLimit: null, // unmetered

  async connect(): Promise<ConnectInfo> {
    const ws = await listWorkspaces();
    return {
      workspaceId: 1, // constant; nothing downstream distinguishes it
      accountName: '',
      projects: workspacesToProjects(ws),
    };
  },

  // No cache in between, so fetch time is data time.
  async fetchEntries(_token, startISO, endISO) {
    const entries = await fetchStoreEntries(startISO, endISO);
    return { entries: entries ?? [], dataAtMs: Date.now() };
  },
};
