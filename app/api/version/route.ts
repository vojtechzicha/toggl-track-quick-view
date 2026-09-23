// Build id of the running deployment, inlined at build time (next.config.js).
// UpdateHint compares it with the tab's own id and asks for a refresh when
// they differ.
//
// Not gated: it exposes only a commit hash prefix, and the hint must also work
// on a tab at the password gate.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    // So no CDN caches a stale id.
    { headers: { 'cache-control': 'no-store' } },
  );
}
