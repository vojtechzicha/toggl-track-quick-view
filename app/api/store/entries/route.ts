// Standalone store: entries.
//
// GET  ?start_date&end_date[&limit] — entries overlapping [start, end) in all
//      workspaces, like the Toggl API; the client filters. `limit` returns
//      the newest N by start.
// POST — create an entry. `stop: null` (or omitted) starts a timer and stops
//      any running entry at the new start, as Toggl does.
//
// Mutations return the stored entry so the client can reconcile its
// optimistic state.

import { NextRequest } from 'next/server';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes, storeError } from '@/lib/store/guard';
import { nextSeq, toTimeEntry, type EntryDoc, type WorkspaceDoc } from '@/lib/store/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_LIMIT = 1000;

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function GET(req: NextRequest) {
  const denied = storeGuard(req);
  if (denied) return denied;

  const q = req.nextUrl.searchParams;
  const start = parseDate(q.get('start_date'));
  const end = parseDate(q.get('end_date'));
  if (!start || !end) {
    return jsonRes({ error: 'start_date and end_date must be valid ISO datetimes.' }, 400);
  }
  const limitRaw = q.get('limit');
  const limit = limitRaw ? Math.min(Math.max(1, Number(limitRaw) || 0), MAX_LIMIT) : 0;

  try {
    const db = await getStoreDb();
    // Overlap, not containment: the client clips entries to days and weeks.
    // A running entry extends to now.
    let cursor = db
      .collection<EntryDoc>('entries')
      .find({
        start: { $lt: end },
        $or: [{ stop: null }, { stop: { $gt: start } }],
      })
      .sort({ start: -1 });
    if (limit) cursor = cursor.limit(limit);
    const docs = await cursor.toArray();
    return Response.json(docs.map(toTimeEntry));
  } catch (e) {
    return storeError(e);
  }
}

export async function POST(req: NextRequest) {
  const denied = storeGuard(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: 'Malformed JSON body.' }, 400);
  }

  const workspaceId = Number(body.workspaceId);
  const start = parseDate(body.start) ?? new Date();
  const stop = body.stop == null ? null : parseDate(body.stop);
  if (body.stop != null && !stop) {
    return jsonRes({ error: 'stop must be null or a valid ISO datetime.' }, 400);
  }
  if (stop && stop.getTime() <= start.getTime()) {
    return jsonRes({ error: 'stop must be after start.' }, 400);
  }
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : [];

  try {
    const db = await getStoreDb();
    const ws = await db
      .collection<WorkspaceDoc>('workspaces')
      .findOne({ numericId: workspaceId });
    if (!ws) return jsonRes({ error: `Workspace ${workspaceId} does not exist.` }, 400);

    const now = new Date();
    const entries = db.collection<EntryDoc>('entries');
    const doc: EntryDoc = {
      numericId: await nextSeq(db, 'entries'),
      workspaceId,
      description,
      start,
      stop,
      tags,
      createdAt: now,
      updatedAt: now,
    };

    // Starting a timer stops the running one at the new start. $max keeps the
    // closed entry at least 1s long if it started at or after the new start.
    // If a concurrent start trips the one-running-timer index, close again
    // and retry once.
    for (let attempt = 0; ; attempt++) {
      if (stop === null) {
        await entries.updateMany({ stop: null }, [
          {
            $set: {
              stop: { $max: [start, { $dateAdd: { startDate: '$start', unit: 'second', amount: 1 } }] },
              updatedAt: now,
            },
          },
        ]);
      }
      try {
        await entries.insertOne(doc);
        break;
      } catch (e) {
        const dup = typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000;
        if (!dup || stop !== null || attempt >= 1) throw e;
      }
    }
    return Response.json(toTimeEntry(doc), { status: 201 });
  } catch (e) {
    return storeError(e);
  }
}
