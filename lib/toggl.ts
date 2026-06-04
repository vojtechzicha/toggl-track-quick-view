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

/** Thrown when the server's password gate needs a (re)login before serving data. */
export class AuthRequiredError extends Error {
  constructor() {
    super('Password required');
  }
}

/** True for the rate-limit responses Toggl uses (402 per docs; 429 elsewhere). */
export function isRateLimit(e: unknown): boolean {
  return e instanceof TogglError && (e.status === 402 || e.status === 429);
}

export function isAuthRequired(e: unknown): boolean {
  return e instanceof AuthRequiredError;
}

// ---- Password-gate session (server-managed deploys with APP_PASSWORD) ----
// We persist only the signed, expiring session token the server hands back —
// never the password itself. See lib/serverAuth.ts for the server side.
const AUTH_KEY = 'tqv.auth.v1';
interface AuthSession {
  token: string;
  exp: number;
}

export function loadAuth(): AuthSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as AuthSession;
    return s && typeof s.token === 'string' && typeof s.exp === 'number' ? s : null;
  } catch {
    return null;
  }
}

/** True if we hold a session token that hasn't expired (client-side check; the
 * server re-validates the signature on every request regardless). */
export function hasValidAuth(): boolean {
  const s = loadAuth();
  return !!s && s.exp > Date.now();
}

export function clearAuth(): void {
  try {
    window.localStorage.removeItem(AUTH_KEY);
  } catch {
    /* ignore */
  }
}

function saveAuth(s: AuthSession): void {
  try {
    window.localStorage.setItem(AUTH_KEY, JSON.stringify(s));
  } catch {
    /* ignore quota / private-mode errors */
  }
}

/** Exchange the password for a session token. Throws TogglError(401) if wrong. */
export async function login(password: string): Promise<void> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new TogglError(res.status);
  const data = (await res.json()) as AuthSession;
  saveAuth(data);
}

async function tApi<T>(path: string, token: string, search?: string): Promise<T> {
  const url = `/api/toggl/${path}${search ? `?${search}` : ''}`;
  const auth = loadAuth();
  const headers: Record<string, string> = {};
  if (token) headers['x-toggl-token'] = token;
  if (auth?.token) headers['x-app-auth'] = auth.token;
  const res = await fetch(url, { headers, cache: 'no-store' });
  // The proxy flags a missing/expired session distinctly so we can re-prompt
  // for the password rather than mistaking it for a Toggl auth failure.
  if (res.status === 401 && res.headers.get('x-app-auth') === 'required') {
    clearAuth();
    throw new AuthRequiredError();
  }
  if (!res.ok) {
    throw new TogglError(res.status);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

export interface AppConfig {
  serverToken: boolean;
  passwordRequired: boolean;
  cache: { enabled: boolean; intervalSec: number | null };
}

const CONFIG_FALLBACK: AppConfig = {
  serverToken: false,
  passwordRequired: false,
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
