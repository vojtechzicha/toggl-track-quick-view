import { NextRequest } from 'next/server';

// Same-origin proxy for the Toggl Track API v9. Browsers cannot call Toggl
// directly: CORS allows only whitelisted origins, and the whitelist call is
// itself blocked by CORS.
//
// The token comes from the `x-toggl-token` header (the browser's token), or
// else TOGGL_API_TOKEN. With TOGGL_CACHE_INTERVAL set, server-token requests
// go through the shared cache (lib/serverCache.ts).

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

  // Password gate: requests using the server token need a valid session.
  // Requests with their own token only reach their own account, so they are
  // not gated. `x-app-auth: required` tells the client to log in again,
  // as distinct from a Toggl 401.
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

  // Cache only the server token, so all viewers are the same user. A manual
  // refresh skips the cached read but still updates the cache.
  const force = req.headers.get('x-toggl-refresh') === '1';
  const interval = cacheIntervalSec();
  if (interval !== null && !headerToken && process.env.TOGGL_API_TOKEN) {
    try {
      const cached = await cachedToggl(joined, search, auth, interval, force);
      // `at` is the original upstream fetch time; the client shows data age.
      return new Response(cached.body, {
        status: cached.status,
        headers: {
          'content-type': cached.contentType,
          'cache-control': 'no-store',
          'x-toggl-fetched-at': String(cached.at),
        },
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
        'x-toggl-fetched-at': String(Date.now()),
      },
    });
  } catch {
    return json({ error: 'Failed to reach the Toggl API.' }, 502);
  }
}
