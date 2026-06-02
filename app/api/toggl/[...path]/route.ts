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
  const token = req.headers.get('x-toggl-token') || process.env.TOGGL_API_TOKEN;

  if (!token) {
    return json({ error: 'Missing Toggl API token.' }, 401);
  }

  const target = `${TOGGL_BASE}/${path.join('/')}${req.nextUrl.search}`;
  const auth = Buffer.from(`${token}:api_token`).toString('base64');

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
