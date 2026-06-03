// Thin client around our same-origin Toggl proxy (see app/api/toggl/...).
// The token is forwarded in a header; the proxy turns it into Basic auth.

import type { TimeEntry } from './calc';

export interface Me {
  id: number;
  fullname: string;
  default_workspace_id: number;
}

export interface Project {
  id: number;
  name: string;
  active: boolean;
  color?: string;
}

export class TogglError extends Error {
  status: number;
  constructor(status: number) {
    super(`Toggl request failed (${status})`);
    this.status = status;
  }
}

/** True for the rate-limit responses Toggl uses (402 per docs; 429 elsewhere). */
export function isRateLimit(e: unknown): boolean {
  return e instanceof TogglError && (e.status === 402 || e.status === 429);
}

async function tApi<T>(path: string, token: string, search?: string): Promise<T> {
  const url = `/api/toggl/${path}${search ? `?${search}` : ''}`;
  const res = await fetch(url, {
    headers: token ? { 'x-toggl-token': token } : {},
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new TogglError(res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface AppConfig {
  serverToken: boolean;
  cache: { enabled: boolean; intervalSec: number | null };
}

const CONFIG_FALLBACK: AppConfig = {
  serverToken: false,
  cache: { enabled: false, intervalSec: null },
};

export async function getConfig(): Promise<AppConfig> {
  const res = await fetch('/api/config', { cache: 'no-store' });
  if (!res.ok) return CONFIG_FALLBACK;
  return res.json();
}

export const getMe = (token: string) => tApi<Me>('me', token);

export const getProjects = (token: string, workspaceId: number) =>
  tApi<Project[]>(`workspaces/${workspaceId}/projects`, token, 'active=true');

export const getCurrent = (token: string) =>
  tApi<TimeEntry | null>('me/time_entries/current', token);

export const getEntries = (token: string, startISO: string, endISO: string) =>
  tApi<TimeEntry[]>(
    'me/time_entries',
    token,
    `start_date=${encodeURIComponent(startISO)}&end_date=${encodeURIComponent(endISO)}`
  );
