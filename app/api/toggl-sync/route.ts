// One sync round (pull if stale, daily re-read, push the queue), for the
// scheduled workflow (.github/workflows/toggl-sync.yml), so queued entries
// reach Toggl while nobody has the app open.
//
// Unauthenticated on purpose: it returns only counts, a pull runs at most
// once per interval, and a push only sends what is already queued, within
// the quota reserve. Calling it often cannot spend more than the app would.

import type { NextRequest } from 'next/server';
import { jsonRes } from '@/lib/store/http';
import { checkRateLimit, clientIp } from '@/lib/mcp/http';
import { mirrorEnabled, syncNow } from '@/lib/mirror/sync';
import { queueStatus } from '@/lib/mirror/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function run(req: NextRequest) {
  if (!mirrorEnabled()) return jsonRes({ error: 'The local copy is not enabled on this deployment.' }, 404);
  if (!checkRateLimit(`toggl-sync:${clientIp(req)}`, { limit: 10, windowMs: 60_000 }).success) {
    return jsonRes({ error: 'Too many requests.' }, 429);
  }
  const result = await syncNow({ pull: 'stale', push: true, budgetMs: 40_000 });
  const q = await queueStatus();
  return jsonRes(
    {
      ok: !result.error,
      pulled: result.pulled,
      pushed: result.push?.pushed ?? 0,
      stopped: result.push?.stopped ?? null,
      waiting: q.pending,
      failed: q.failed,
      conflicts: q.conflicts,
      ...(result.error ? { error: result.error } : {}),
    },
    result.error ? 502 : 200
  );
}

export const GET = run;
export const POST = run;
