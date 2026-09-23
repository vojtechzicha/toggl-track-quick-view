// Server side of the password gate (APP_PASSWORD). Without it, a deployment
// holding TOGGL_API_TOKEN is readable by anyone with the URL. See README
// "Password protection".
//
//  - The password is only compared against, never stored.
//  - Sessions are stateless HMAC-signed tokens, so any serverless instance can
//    validate them.
//  - The signing key is derived from the password, so rotating APP_PASSWORD
//    invalidates every session.
//  - All comparisons are timing-safe.

import crypto from 'crypto';

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days

// Domain-separation salt for the derived signing key.
const KEY_SALT = 'tqv-auth-v1';

/**
 * Active when APP_PASSWORD is set and the server holds data worth guarding:
 * a Toggl token, or a database (MONGODB_URI) whose routes write. The store
 * and sync routes require the password (lib/store/guard.ts).
 */
export function gateEnabled(): boolean {
  return (
    !!process.env.APP_PASSWORD &&
    (!!process.env.TOGGL_API_TOKEN || !!process.env.MONGODB_URI)
  );
}

// Signing key = HMAC(salt, password). A leaked token does not reveal the
// password, and tokens cannot be forged without it.
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
  // timingSafeEqual needs equal lengths. A valid signature always has the
  // same length, so a mismatch means a malformed token.
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
