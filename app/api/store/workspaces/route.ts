// Standalone store: the workspaces collection.
//
// A workspace is both a stored settings snapshot (the successor of localStorage
// presets) and the "project" its entries carry (TimeEntry.project_id =
// workspaces.numericId — see lib/store/model.ts).
//
// GET  — every workspace with its settings, sorted by name.
// POST — create. Body: { name, color?, settings? }. The server allocates the
//        numeric id, auto-assigns a palette color when none is given, and
//        always points the new workspace's selection at ITSELF — a new
//        workspace tracks itself by default; multi-workspace setups are a
//        Settings edit afterwards.

import { NextRequest } from 'next/server';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes } from '@/lib/store/guard';
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
  } catch {
    return jsonRes({ error: 'Failed to reach the store.' }, 502);
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
    // A workspace tracks itself: its numeric id in the project slot is what
    // keeps ProjectSet / codeMappings working unchanged downstream.
    settings.selectedProjects = [{ id: numericId, name, color }];
    settings.groupName = '';

    const doc: WorkspaceDoc = { numericId, name, color, settings, createdAt: new Date() };
    await db.collection<WorkspaceDoc>('workspaces').insertOne(doc);
    return Response.json(toStoreWorkspace(doc), { status: 201 });
  } catch {
    return jsonRes({ error: 'Failed to reach the store.' }, 502);
  }
}
