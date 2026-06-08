import { NextRequest } from 'next/server';

// Server-side proxy for the Toggl Track API (v9).
//
// The browser cannot call the Toggl API directly: v9 only allows cross-origin
// requests from domains a user has explicitly whitelisted, and that whitelist
// call is itself blocked by CORS from the browser. Routing every request
// through this same-origin proxy sidesteps the problem entirely and keeps the
// API token out of any third-party hands.
//
// The token is taken from the `x-toggl-token` request header (sent by the
// client from localStorage) or, as a fallback, from the TOGGL_API_TOKEN
// environment variable (handy when deploying a private instance to Vercel).
//
// When TOGGL_CACHE_INTERVAL is set AND we're using the server-held token,
// responses are served from a shared in-process cache (see lib/serverCache.ts)
// so multiple devices/tabs collapse onto a single upstream request per
// interval instead of each spending from Toggl's hourly budget.

import { cacheIntervalSec, cachedToggl } from '@/lib/serverCache';
import { gateEnabled, verifyToken } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TOGGL_BASE = 'https://api.track.toggl.com/api/v9';

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const headerToken = req.headers.get('x-toggl-token');

  // Password gate: requests that would fall back to the SERVER token must carry
  // a valid app session token. Requests bringing their own browser token use
  // that user's own Toggl account, so they aren't gated. The `x-app-auth:
  // required` header lets the client tell "log in" apart from a Toggl 401 and
  // re-prompt for the password.
  if (gateEnabled() && !headerToken && !verifyToken(req.headers.get('x-app-auth'))) {
    return new Response(JSON.stringify({ error: 'auth_required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-app-auth': 'required' },
    });
  }

  const token = headerToken || process.env.TOGGL_API_TOKEN;

  if (!token) {
    return json({ error: 'Missing Toggl API token.' }, 401);
  }

  const joined = path.join('/');
  const search = req.nextUrl.search;
  const auth = Buffer.from(`${token}:api_token`).toString('base64');

  // Shared-cache path: only for the server's own token (no per-browser token),
  // so every cached viewer is the same user seeing identical data.
  // A manual refresh asks for live data, bypassing the shared cache read (but
  // the fresh value still updates the cache for everyone else).
  const force = req.headers.get('x-toggl-refresh') === '1';
  const interval = cacheIntervalSec();
  if (interval !== null && !headerToken && process.env.TOGGL_API_TOKEN) {
    try {
      const cached = await cachedToggl(joined, search, auth, interval, force);
      return new Response(cached.body, {
        status: cached.status,
        headers: { 'content-type': cached.contentType, 'cache-control': 'no-store' },
      });
    } catch {
      return json({ error: 'Failed to reach the Toggl API.' }, 502);
    }
  }

  const target = `${TOGGL_BASE}/${joined}${search}`;

  try {
    const res = await fetch(target, {
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    });

    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return json({ error: 'Failed to reach the Toggl API.' }, 502);
  }
}
