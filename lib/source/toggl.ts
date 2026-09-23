// Toggl source: client for the same-origin proxy (app/api/toggl/...) as a
// TrackBackend. The token goes in a header; the proxy turns it into Basic auth.

import type { TimeEntry } from '@/lib/calc';
import { ApiError, AuthRequiredError } from './errors';
import { loadAuth, clearAuth } from './auth';
import type { ConnectInfo, TrackBackend, TrackProject } from './types';

export const HOURLY_LIMIT = 30; // Toggl Free: 30 requests/hour

interface Me {
  id: number;
  fullname: string;
  default_workspace_id: number;
}

async function tApiMeta<T>(
  path: string,
  token: string,
  search?: string,
  opts?: { force?: boolean }
): Promise<{ data: T; fetchedAtMs: number | null }> {
  const url = `/api/toggl/${path}${search ? `?${search}` : ''}`;
  const auth = loadAuth();
  const headers: Record<string, string> = {};
  if (token) headers['x-toggl-token'] = token;
  if (auth?.token) headers['x-app-auth'] = auth.token;
  // Ask the proxy to bypass its shared cache for a manual refresh.
  if (opts?.force) headers['x-toggl-refresh'] = '1';
  const res = await fetch(url, { headers, cache: 'no-store' });
  // Distinguishes a missing/expired session from a Toggl auth failure.
  if (res.status === 401 && res.headers.get('x-app-auth') === 'required') {
    clearAuth();
    throw new AuthRequiredError();
  }
  if (!res.ok) {
    throw new ApiError(res.status);
  }
  const text = await res.text();
  // On a server-cache hit this is the original upstream fetch time.
  const at = Number(res.headers.get('x-toggl-fetched-at'));
  return {
    data: (text ? JSON.parse(text) : null) as T,
    fetchedAtMs: Number.isFinite(at) && at > 0 ? at : null,
  };
}

const tApi = async <T>(
  path: string,
  token: string,
  search?: string,
  opts?: { force?: boolean }
): Promise<T> => (await tApiMeta<T>(path, token, search, opts)).data;

export const getMe = (token: string) => tApi<Me>('me', token);

export const getProjects = (token: string, workspaceId: number) =>
  tApi<TrackProject[]>(`workspaces/${workspaceId}/projects`, token, 'active=true');

export const getEntries = (
  token: string,
  startISO: string,
  endISO: string,
  opts?: { force?: boolean }
) =>
  tApi<TimeEntry[]>(
    'me/time_entries',
    token,
    `start_date=${encodeURIComponent(startISO)}&end_date=${encodeURIComponent(endISO)}`,
    opts
  );

export const togglBackend: TrackBackend = {
  mode: 'toggl',
  hourlyRequestLimit: HOURLY_LIMIT,

  // Two requests: me (account + default workspace), then its active projects.
  async connect(token: string): Promise<ConnectInfo> {
    const me = await getMe(token);
    const projects = await getProjects(token, me.default_workspace_id);
    return {
      workspaceId: me.default_workspace_id,
      accountName: me.fullname ?? '',
      projects: (projects ?? [])
        .filter((p) => p.active !== false)
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },

  async fetchEntries(token, startISO, endISO, opts) {
    const { data, fetchedAtMs } = await tApiMeta<TimeEntry[]>(
      'me/time_entries',
      token,
      `start_date=${encodeURIComponent(startISO)}&end_date=${encodeURIComponent(endISO)}`,
      opts
    );
    return { entries: data ?? [], dataAtMs: fetchedAtMs };
  },
};
