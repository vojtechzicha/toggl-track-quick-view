// Reports the build id of the deployment currently serving requests. The id
// is inlined at build time (see next.config.js), so whatever build produced
// the running server code is the id this route returns. A browser tab whose
// own inlined id differs was loaded from an older deploy — the UpdateHint
// component polls this route and asks the user to refresh in that case.
//
// Deliberately ungated: it exposes nothing but an opaque random id, and the
// hint must work even on a tab still sitting at the password gate.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    // Explicit no-store so no CDN in front of the app ever pins a stale id.
    { headers: { 'cache-control': 'no-store' } },
  );
}
