// Standalone store: one workspace by its numeric id.
//
// PATCH  — partial update: name, color, settings (settings replace wholesale —
//          the client always sends a complete snapshot).
// DELETE — delete. Refused with 409 while the workspace still has entries;
//          ?force=1 cascades and deletes them too.

import { NextRequest } from 'next/server';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes, storeError } from '@/lib/store/guard';
import { isHexColor, toStoreWorkspace, type WorkspaceDoc } from '@/lib/store/model';
import type { PresetValue } from '@/components/SettingsPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function workspaceId(params: Promise<{ id: string }>): Promise<number | null> {
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
  const id = await workspaceId(params);
  if (id === null) return jsonRes({ error: 'Invalid workspace id.' }, 400);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: 'Malformed JSON body.' }, 400);
  }

  const patch: Partial<WorkspaceDoc> = {};
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return jsonRes({ error: 'name must not be empty.' }, 400);
    patch.name = name;
  }
  if ('color' in body) {
    if (!isHexColor(body.color)) return jsonRes({ error: 'color must be #rrggbb.' }, 400);
    patch.color = body.color.trim();
  }
  if ('settings' in body) {
    if (!body.settings || typeof body.settings !== 'object') {
      return jsonRes({ error: 'settings must be an object.' }, 400);
    }
    patch.settings = body.settings as PresetValue;
  }

  try {
    const db = await getStoreDb();
    const ws = db.collection<WorkspaceDoc>('workspaces');
    const doc = await ws.findOne({ numericId: id });
    if (!doc) return jsonRes({ error: 'Workspace not found.' }, 404);
    if (Object.keys(patch).length > 0) await ws.updateOne({ numericId: id }, { $set: patch });
    return Response.json(toStoreWorkspace({ ...doc, ...patch }));
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
  const id = await workspaceId(params);
  if (id === null) return jsonRes({ error: 'Invalid workspace id.' }, 400);
  const force = req.nextUrl.searchParams.get('force') === '1';

  try {
    const db = await getStoreDb();
    const entryCount = await db.collection('entries').countDocuments({ workspaceId: id });
    if (entryCount > 0 && !force) {
      return jsonRes(
        { error: `Workspace still has ${entryCount} entries.`, entries: entryCount },
        409
      );
    }
    const res = await db.collection<WorkspaceDoc>('workspaces').deleteOne({ numericId: id });
    if (res.deletedCount === 0) return jsonRes({ error: 'Workspace not found.' }, 404);
    if (entryCount > 0) await db.collection('entries').deleteMany({ workspaceId: id });
    return Response.json({ ok: true, deletedEntries: entryCount });
  } catch (e) {
    return storeError(e);
  }
}
