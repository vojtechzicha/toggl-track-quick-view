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

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const serverToken = !!process.env.TOGGL_API_TOKEN;
  const interval = cacheIntervalSec();
  const cacheEnabled = serverToken && interval !== null;
  return Response.json({
    serverToken,
    passwordRequired: gateEnabled(),
    misconfigured: null,
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
