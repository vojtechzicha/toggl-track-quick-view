// Password-gate session for server-managed deploys (APP_PASSWORD). We persist
// only the signed, expiring session token the server hands back — never the
// password itself. See lib/serverAuth.ts for the server side. This is shared
// by every track source: the Toggl proxy and the standalone store sit behind
// the same gate.

import { ApiError } from './errors';

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

/** Exchange the password for a session token. Throws ApiError(401) if wrong. */
export async function login(password: string): Promise<void> {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw new ApiError(res.status);
  const data = (await res.json()) as AuthSession;
  saveAuth(data);
}
