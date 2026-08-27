// Reports server-side configuration the client needs on load:
//  - mode: which track source this deployment serves. MONGODB_URI switches it
//    to 'standalone' (the app's own MongoDB store); otherwise 'toggl'.
//  - serverToken: whether the server already holds a Toggl token (via
//    TOGGL_API_TOKEN). When true, the client runs in "server-managed" mode: it
//    connects without a browser token and hides the token UI entirely.
//    Standalone mode is always server-managed (there is no browser credential).
//  - cache: whether the shared server-side response cache is active (requires
//    both a server token and TOGGL_CACHE_INTERVAL) and its refresh interval.
//    Toggl-mode only — the standalone store has no rate limit to work around.
//  - passwordRequired: whether the password gate is active, so the client
//    knows to prompt for the password before fetching.
//  - sync: whether cross-device settings sync is available (MONGODB_URI +
//    APP_PASSWORD, any mode — Toggl mode keeps its source with APP_MODE=toggl),
//    plus a sync-specific misconfiguration message when applicable.
//  - timestamp: whether an RFC 3161 timestamp authority is configured (TSA_URL),
//    which is what lets a signed export be PAdES-B-T instead of B-B. The URL
//    itself is never sent — only whether there is one.
//  - misconfigured: a human-readable problem the operator must fix (currently
//    only: standalone mode without APP_PASSWORD — the store routes are writes,
//    so they refuse to serve until one is set).
//
// Neither the token nor the password is ever exposed — only their presence.

import { cacheIntervalSec } from '@/lib/serverCache';
import { gateEnabled } from '@/lib/serverAuth';
import { standaloneEnabled } from '@/lib/store/mongo';
import { syncEnabled, syncMisconfigured } from '@/lib/sync/server';
import { tsaUrl } from '@/lib/serverTimestamp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const standalone = standaloneEnabled();
  const serverToken = !!process.env.TOGGL_API_TOKEN;
  const interval = cacheIntervalSec();
  const cacheEnabled = !standalone && serverToken && interval !== null;
  return Response.json({
    mode: standalone ? 'standalone' : 'toggl',
    serverToken,
    passwordRequired: gateEnabled(),
    misconfigured:
      standalone && !process.env.APP_PASSWORD
        ? 'APP_PASSWORD must be set in standalone mode — the store accepts writes.'
        : null,
    cache: {
      enabled: cacheEnabled,
      intervalSec: cacheEnabled ? interval : null,
    },
    sync: {
      enabled: syncEnabled(),
      misconfigured: syncMisconfigured(),
    },
    timestamp: { enabled: tsaUrl() !== null },
  });
}
