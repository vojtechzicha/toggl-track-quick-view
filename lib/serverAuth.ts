// Server-side password gate for the single-user, server-managed deploy.
//
// When the app holds the Toggl token itself (TOGGL_API_TOKEN) the dashboard is
// otherwise readable by anyone who knows the URL. Setting APP_PASSWORD turns on
// a password gate: the Toggl proxy refuses to serve the server token's data
// unless the request carries a valid session token.
//
// Design goals (see README "Password protection"):
//  - The password is NEVER stored — not on the client, not on the server beyond
//    the env var the operator set. We only ever compare against it.
//  - Sessions are stateless, signed tokens (HMAC), so there's nothing to persist
//    server-side and any number of stateless/serverless instances validate them.
//  - The HMAC signing key is derived FROM the password, so rotating APP_PASSWORD
//    instantly invalidates every issued session — no separate secret to manage.
//  - All comparisons are timing-safe.

import crypto from 'crypto';

// How long an issued session stays valid. The client is asked for the password
// at most once per this window.
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

// Domain-separation salt so the derived signing key is specific to this use.
const KEY_SALT = 'tqv-auth-v1';

/**
 * The gate is active in server-managed deploys WITH a password configured:
 * either the server holds the Toggl token, or the app runs in standalone mode
 * (MONGODB_URI), where the store routes mutate data and the password is
 * therefore required rather than optional (see lib/store/guard.ts).
 */
export function gateEnabled(): boolean {
  return (
    !!process.env.APP_PASSWORD &&
    (!!process.env.TOGGL_API_TOKEN || !!process.env.MONGODB_URI)
  );
}

// Signing key = HMAC(salt, password). One-way: a leaked token can't reveal the
// password, and a token can't be forged without knowing the password.
function signingKey(): Buffer {
  return crypto
    .createHmac('sha256', KEY_SALT)
    .update(process.env.APP_PASSWORD || '')
    .digest();
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

/** Issue a fresh session token of the form `<exp>.<sig>`. */
export function issueToken(now = Date.now()): { token: string; exp: number } {
  const exp = now + SESSION_TTL_MS;
  const payload = String(exp);
  return { token: `${payload}.${sign(payload)}`, exp };
}

/** True iff `token` is well-formed, unexpired, and correctly signed. */
export function verifyToken(token: string | null | undefined, now = Date.now()): boolean {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp <= now) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Lengths must match before timingSafeEqual; base64url of a fixed-size HMAC is
  // constant-length, so a mismatch here just means a malformed token.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Timing-safe password check. Digests first so length never leaks. */
export function verifyPassword(input: string | null | undefined): boolean {
  const expected = process.env.APP_PASSWORD || '';
  if (!expected || !input) return false;
  const a = crypto.createHash('sha256').update(input).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
