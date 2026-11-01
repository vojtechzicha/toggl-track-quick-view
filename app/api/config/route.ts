// Server configuration the client needs on load. Public: it reports only
// whether secrets are set, never their values.
//  - serverToken: TOGGL_API_TOKEN is set; the client hides the token UI.
//  - cache: whether the server response cache is on (server token plus
//    TOGGL_CACHE_INTERVAL) and its interval.
//  - passwordRequired: the password gate is active.
//  - sync: settings sync availability (MONGODB_URI + APP_PASSWORD) and any
//    sync misconfiguration.
//  - timestamp: an RFC 3161 timestamp authority (TSA_URL) is set, so signed
//    exports can be PAdES-B-T instead of B-B.
//  - misconfigured: a problem the operator must fix, or null. Nothing sets it
//    today; sync reports its own problems under `sync`.

import { cacheIntervalSec } from '@/lib/serverCache';
import { gateEnabled } from '@/lib/serverAuth';
import { syncEnabled, syncMisconfigured } from '@/lib/sync/server';
import { tsaUrl } from '@/lib/serverTimestamp';
import { mirrorEnabled, pullIntervalSec } from '@/lib/mirror/sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const serverToken = !!process.env.TOGGL_API_TOKEN;
  const interval = cacheIntervalSec();
  const mirror = mirrorEnabled();
  // With the local copy, entries come from /api/entries, refreshed from
  // Toggl once per interval for every device: a shared cache, as far as the
  // client is concerned.
  const cacheEnabled = mirror || (serverToken && interval !== null);
  return Response.json({
    mirror: { enabled: mirror },
    serverToken,
    passwordRequired: gateEnabled(),
    misconfigured: null,
    cache: {
      enabled: cacheEnabled,
      intervalSec: mirror ? pullIntervalSec() : cacheEnabled ? interval : null,
    },
    sync: {
      enabled: syncEnabled(),
      misconfigured: syncMisconfigured(),
    },
    timestamp: { enabled: tsaUrl() !== null },
  });
}
