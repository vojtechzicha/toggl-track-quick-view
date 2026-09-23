// Access guard for every /api/store route. These routes write data, so the
// password gate is mandatory: without APP_PASSWORD they refuse to run rather
// than stay open. Session tokens: lib/serverAuth.ts.

import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/serverAuth';
import { standaloneEnabled } from './mongo';

export function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 502 for a database error. The cause is logged and returned in `detail`.
 * Safe to expose because only gated users reach these routes, and it makes
 * a bad Atlas URI or network-access list diagnosable.
 */
export function storeError(e: unknown): Response {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error('[store]', e);
  return jsonRes({ error: 'Failed to reach the store.', detail }, 502);
}

/**
 * An error Response if the request may not touch the store, else null. The
 * `x-app-auth: required` header on the 401 tells the client to log in again.
 */
export function storeGuard(req: NextRequest): Response | null {
  if (!standaloneEnabled()) {
    return jsonRes({ error: 'Standalone mode is not enabled (MONGODB_URI is not set).' }, 404);
  }
  if (!process.env.APP_PASSWORD) {
    return jsonRes(
      { error: 'Misconfigured: APP_PASSWORD must be set in standalone mode.' },
      500
    );
  }
  if (!verifyToken(req.headers.get('x-app-auth'))) {
    return new Response(JSON.stringify({ error: 'auth_required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-app-auth': 'required' },
    });
  }
  return null;
}
