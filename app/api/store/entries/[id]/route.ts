// Standalone store: one entry by its numeric id.
//
// PATCH — partial update: description, tags, start, stop, workspaceId. Setting
//         `stop: null` restarts the entry as the running timer (409 if another
//         entry is already running — the partial unique index enforces it).
// DELETE — delete the entry.

import { NextRequest } from 'next/server';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes, storeError } from '@/lib/store/guard';
import { toTimeEntry, type EntryDoc, type WorkspaceDoc } from '@/lib/store/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

async function entryId(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = storeGuard(req);
  if (denied) return denied;
  const id = await entryId(params);
  if (id === null) return jsonRes({ error: 'Invalid entry id.' }, 400);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: 'Malformed JSON body.' }, 400);
  }

  try {
    const db = await getStoreDb();
    const entries = db.collection<EntryDoc>('entries');
    const doc = await entries.findOne({ numericId: id });
    if (!doc) return jsonRes({ error: 'Entry not found.' }, 404);

    const patch: Partial<EntryDoc> = {};
    if ('description' in body) {
      patch.description = typeof body.description === 'string' ? body.description.trim() : '';
    }
    if ('tags' in body) {
      patch.tags = Array.isArray(body.tags)
        ? body.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        : [];
    }
    if ('workspaceId' in body) {
      const wsId = Number(body.workspaceId);
      const ws = await db.collection<WorkspaceDoc>('workspaces').findOne({ numericId: wsId });
      if (!ws) return jsonRes({ error: `Workspace ${wsId} does not exist.` }, 400);
      patch.workspaceId = wsId;
    }
    if ('start' in body) {
      const d = parseDate(body.start);
      if (!d) return jsonRes({ error: 'start must be a valid ISO datetime.' }, 400);
      patch.start = d;
    }
    if ('stop' in body) {
      if (body.stop === null) {
        patch.stop = null;
      } else {
        const d = parseDate(body.stop);
        if (!d) return jsonRes({ error: 'stop must be null or a valid ISO datetime.' }, 400);
        patch.stop = d;
      }
    }

    const next: EntryDoc = { ...doc, ...patch, updatedAt: new Date() };
    if (next.stop && next.stop.getTime() <= next.start.getTime()) {
      return jsonRes({ error: 'stop must be after start.' }, 400);
    }

    try {
      await entries.updateOne({ numericId: id }, { $set: { ...patch, updatedAt: next.updatedAt } });
    } catch (e) {
      // Restarting this entry while another is running trips the one-running-
      // timer unique index — surface it as a conflict, not a server error.
      if (typeof e === 'object' && e !== null && (e as { code?: number }).code === 11000) {
        return jsonRes({ error: 'Another entry is already running.' }, 409);
      }
      throw e;
    }
    return Response.json(toTimeEntry(next));
  } catch (e) {
    return storeError(e);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = storeGuard(req);
  if (denied) return denied;
  const id = await entryId(params);
  if (id === null) return jsonRes({ error: 'Invalid entry id.' }, 400);

  try {
    const db = await getStoreDb();
    const res = await db.collection<EntryDoc>('entries').deleteOne({ numericId: id });
    if (res.deletedCount === 0) return jsonRes({ error: 'Entry not found.' }, 404);
    return Response.json({ ok: true });
  } catch (e) {
    return storeError(e);
  }
}
