// The standalone source: a thin client around the app's own MongoDB-backed
// store (see app/api/store/...) wrapped in the TrackBackend contract, plus the
// mutation calls only the tracker UI and the Settings workspace section use.
//
// Every request carries the password-gate session token — in standalone mode
// the gate is mandatory (the store accepts writes), so there is no per-user
// credential like the Toggl token; the `token` arguments of the TrackBackend
// contract are simply ignored.

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
  opts: { method?: string; body?: unknown; search?: string } = {}
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
  });
  // Session missing/expired: re-prompt for the password (same flag the Toggl
  // proxy uses, so the shared error classifiers work unchanged).
  if (res.status === 401 && res.headers.get('x-app-auth') === 'required') {
    clearAuth();
    throw new AuthRequiredError();
  }
  if (!res.ok) {
    throw new ApiError(res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ---- Workspaces ----
export const listWorkspaces = () => sApi<StoreWorkspace[]>('workspaces');

export const createWorkspaceApi = (name: string, settings?: PresetValue) =>
  sApi<StoreWorkspace>('workspaces', { method: 'POST', body: { name, settings } });

export const updateWorkspaceApi = (
  id: number,
  patch: { name?: string; color?: string; settings?: PresetValue }
) => sApi<StoreWorkspace>(`workspaces/${id}`, { method: 'PATCH', body: patch });

export const deleteWorkspaceApi = (id: number, force = false) =>
  sApi<{ ok: true }>(`workspaces/${id}`, {
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

/** Map stored workspaces to the picker-ready project list the UI consumes. */
export function workspacesToProjects(ws: StoreWorkspace[]): ConnectInfo['projects'] {
  return ws
    .map((w) => ({ id: w.id, name: w.name, color: w.color }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const standaloneBackend: TrackBackend = {
  mode: 'standalone',
  hourlyRequestLimit: null, // our own store — the request meter goes dormant

  async connect(): Promise<ConnectInfo> {
    const ws = await listWorkspaces();
    return {
      workspaceId: 1, // constant; nothing downstream distinguishes it
      accountName: '',
      projects: workspacesToProjects(ws),
    };
  },

  fetchEntries: (_token, startISO, endISO) => fetchStoreEntries(startISO, endISO),
};
