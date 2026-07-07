// Standalone store: stop the running entry (stop = now). 409 if the entry
// isn't running. Returns the canonical stopped entry.

import { NextRequest } from 'next/server';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes, storeError } from '@/lib/store/guard';
import { toTimeEntry, type EntryDoc } from '@/lib/store/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = storeGuard(req);
  if (denied) return denied;
  const { id: idRaw } = await params;
  const id = Number(idRaw);
  if (!Number.isInteger(id) || id <= 0) return jsonRes({ error: 'Invalid entry id.' }, 400);

  try {
    const db = await getStoreDb();
    const entries = db.collection<EntryDoc>('entries');
    const doc = await entries.findOne({ numericId: id });
    if (!doc) return jsonRes({ error: 'Entry not found.' }, 404);
    if (doc.stop !== null) return jsonRes({ error: 'Entry is not running.' }, 409);

    const now = new Date();
    // Never produce an empty span — a timer stopped within its first second
    // still records one second.
    const stop = new Date(Math.max(now.getTime(), doc.start.getTime() + 1000));
    await entries.updateOne({ numericId: id }, { $set: { stop, updatedAt: now } });
    return Response.json(toTimeEntry({ ...doc, stop, updatedAt: now }));
  } catch (e) {
    return storeError(e);
  }
}
