// Standalone store: workspaces. A workspace is a settings snapshot and also
// the project its entries carry (lib/store/model.ts).
//
// GET  — all workspaces with settings, sorted by name.
// POST — create. Body: { name, color?, settings? }. The server allocates the
//        id, picks a palette color if none is given, and sets the new
//        workspace to track only itself.

import { NextRequest } from 'next/server';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes, storeError } from '@/lib/store/guard';
import {
  autoColor,
  defaultWorkspaceSettings,
  isHexColor,
  nextSeq,
  toStoreWorkspace,
  type WorkspaceDoc,
} from '@/lib/store/model';
import type { PresetValue } from '@/components/SettingsPanel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const denied = storeGuard(req);
  if (denied) return denied;
  try {
    const db = await getStoreDb();
    const docs = await db
      .collection<WorkspaceDoc>('workspaces')
      .find({})
      .sort({ name: 1 })
      .toArray();
    return Response.json(docs.map(toStoreWorkspace));
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
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return jsonRes({ error: 'name is required.' }, 400);

  try {
    const db = await getStoreDb();
    const numericId = await nextSeq(db, 'workspaces');
    const color = isHexColor(body.color) ? body.color.trim() : autoColor(numericId);
    const settings: PresetValue =
      body.settings && typeof body.settings === 'object'
        ? { ...defaultWorkspaceSettings(), ...(body.settings as Partial<PresetValue>) }
        : defaultWorkspaceSettings();
    settings.selectedProjects = [{ id: numericId, name, color }];
    settings.groupName = '';

    const doc: WorkspaceDoc = { numericId, name, color, settings, createdAt: new Date() };
    await db.collection<WorkspaceDoc>('workspaces').insertOne(doc);
    return Response.json(toStoreWorkspace(doc), { status: 201 });
  } catch (e) {
    return storeError(e);
  }
}
