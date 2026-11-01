// The dashboard's and timesheet's time entries, served from the mirror
// (lib/mirror) instead of straight from Toggl. One incremental pull per
// interval keeps it current for every device; older weeks and exports cost no
// Toggl request once read. Queued changes are pushed after the response.
//
// GET ?start_date&end_date → TimeEntry[]
//   x-toggl-refresh: 1     re-reads the range from Toggl (the timesheet's ↻)
//   x-toggl-fetched-at     when Toggl was last read (ms)
//   x-mirror-pending       changes not yet in Toggl
//
// Only with the server token and a database (mirrorEnabled); otherwise the
// client reads through /api/toggl as before.

import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/serverAuth';
import { jsonRes, storeError } from '@/lib/store/http';
import { mirrorEnabled, refreshRange, syncAfterResponse, ensureCovered } from '@/lib/mirror/sync';
import { readMirror } from '@/lib/mirror/read';
import { toTimeEntry } from '@/lib/mirror/model';
import { queueStatus } from '@/lib/mirror/store';
import { isQuotaError } from '@/lib/toggl/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!mirrorEnabled()) return jsonRes({ error: 'The local copy needs TOGGL_API_TOKEN and MONGODB_URI.' }, 404);
  if (!verifyToken(req.headers.get('x-app-auth'))) {
    return new Response(JSON.stringify({ error: 'auth_required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-app-auth': 'required' },
    });
  }
  const fromMs = Date.parse(req.nextUrl.searchParams.get('start_date') ?? '');
  const toMs = Date.parse(req.nextUrl.searchParams.get('end_date') ?? '');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return jsonRes({ error: 'start_date and end_date must be ISO times, start before end.' }, 400);
  }
  try {
    if (req.headers.get('x-toggl-refresh') === '1') {
      await ensureCovered(fromMs);
      await refreshRange(fromMs, toMs);
    }
    const read = await readMirror(fromMs, toMs);
    const q = await queueStatus();
    if (q.pending > 0) await syncAfterResponse({ pull: 'none' });
    return new Response(JSON.stringify(read.docs.map(toTimeEntry)), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-toggl-fetched-at': String(read.dataAtMs ?? Date.now()),
        'x-mirror-pending': String(q.pending),
      },
    });
  } catch (e) {
    if (isQuotaError(e)) return jsonRes({ error: 'Toggl rate limit reached.' }, 429);
    return storeError(e);
  }
}
