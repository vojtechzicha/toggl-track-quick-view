// Access guard shared by every /api/store route.
//
// The store routes MUTATE data, so unlike the read-only Toggl proxy the
// password gate is not optional here: standalone mode requires APP_PASSWORD,
// and a deployment without one is refused as misconfigured rather than left
// open to anyone who knows the URL. The session-token mechanics are the same
// gate the Toggl proxy uses (lib/serverAuth.ts).

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
 * Returns an error Response when the request may not touch the store, or null
 * to proceed. The `x-app-auth: required` header on the 401 is what lets the
 * client tell "log in again" apart from any other failure.
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
