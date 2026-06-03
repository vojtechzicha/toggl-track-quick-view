// Reports server-side configuration the client needs on load:
//  - serverToken: whether the server already holds a Toggl token (via
//    TOGGL_API_TOKEN). When true, the client runs in "server-managed" mode: it
//    connects without a browser token and hides the token UI entirely.
//  - cache: whether the shared server-side response cache is active (requires
//    both a server token and TOGGL_CACHE_INTERVAL) and its refresh interval.
//    When enabled, the client hides the refresh-frequency picker and polls at
//    the server-driven interval instead.
//
// The token value itself is never exposed — only its presence.

import { cacheIntervalSec } from '@/lib/serverCache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const serverToken = !!process.env.TOGGL_API_TOKEN;
  const interval = cacheIntervalSec();
  const cacheEnabled = serverToken && interval !== null;
  return Response.json({
    serverToken,
    cache: {
      enabled: cacheEnabled,
      intervalSec: cacheEnabled ? interval : null,
    },
  });
}
