// Settings sync: one revisioned document per deployment.
//
// GET  → { doc: SyncDoc | null }                       (null = never synced)
// PUT  { baseRev, device, payload } →
//        200 { rev, updatedAt, device }                 (write accepted)
//        409 { conflict: true, doc: SyncDoc }           (baseRev is stale)
//
// A device may only replace the revision it last saw. `baseRev: null` only
// creates the document; if one exists the caller gets a 409 with it, so a
// fresh device cannot wipe an existing setup.
//
// Works in both modes whenever MONGODB_URI is set. Both methods require the
// password gate, like the store routes.

import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/serverAuth';
import { getStoreDb } from '@/lib/store/mongo';
import { jsonRes, storeError } from '@/lib/store/guard';
import type { SyncDoc, SyncPayload } from '@/lib/sync/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const COLLECTION = 'settingsSync';
const DOC_ID = 'settings';

interface SyncDbDoc {
  _id: string;
  rev: number;
  updatedAt: Date;
  device: string;
  payload: SyncPayload;
}

function toWire(doc: SyncDbDoc): SyncDoc {
  return {
    rev: doc.rev,
    updatedAt:
      doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : String(doc.updatedAt),
    device: doc.device ?? '',
    payload: doc.payload,
  };
}

/** storeGuard without the standalone-mode requirement. */
function syncGuard(req: NextRequest): Response | null {
  if (!process.env.MONGODB_URI) {
    return jsonRes({ error: 'Settings sync is not enabled (MONGODB_URI is not set).' }, 404);
  }
  if (!process.env.APP_PASSWORD) {
    return jsonRes(
      { error: 'Misconfigured: APP_PASSWORD must be set for settings sync.' },
      500
    );
  }
  if (!verifyToken(req.headers.get('x-app-auth'))) {
    return new Response(JSON.stringify({ error: 'auth_required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-app-auth': 'required' },
    });
  }
  return null;
}

export async function GET(req: NextRequest) {
  const guard = syncGuard(req);
  if (guard) return guard;
  try {
    const db = await getStoreDb();
    const doc = await db.collection<SyncDbDoc>(COLLECTION).findOne({ _id: DOC_ID });
    return jsonRes({ doc: doc ? toWire(doc) : null }, 200);
  } catch (e) {
    return storeError(e);
  }
}

export async function PUT(req: NextRequest) {
  const guard = syncGuard(req);
  if (guard) return guard;

  let body: { baseRev?: number | null; device?: string; payload?: SyncPayload };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonRes({ error: 'Invalid JSON body.' }, 400);
  }
  const { payload } = body;
  const baseRev = typeof body.baseRev === 'number' ? body.baseRev : null;
  const device = typeof body.device === 'string' ? body.device.slice(0, 80) : '';
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof payload.v !== 'number' ||
    !payload.settings ||
    typeof payload.settings !== 'object'
  ) {
    return jsonRes({ error: 'Invalid sync payload.' }, 400);
  }
  // Defense in depth: never store a credential, even from a buggy client.
  // refreshSec stays per device.
  delete (payload.settings as Record<string, unknown>).token;
  delete (payload.settings as Record<string, unknown>).refreshSec;

  try {
    const db = await getStoreDb();
    const coll = db.collection<SyncDbDoc>(COLLECTION);
    const now = new Date();

    if (baseRev === null) {
      // First sync from this device: create only, never overwrite.
      try {
        await coll.insertOne({ _id: DOC_ID, rev: 1, updatedAt: now, device, payload });
        return jsonRes({ rev: 1, updatedAt: now.toISOString(), device }, 200);
      } catch (e) {
        if ((e as { code?: number }).code === 11000) {
          const cur = await coll.findOne({ _id: DOC_ID });
          if (cur) return jsonRes({ conflict: true, doc: toWire(cur) }, 409);
        }
        throw e;
      }
    }

    // Atomic compare-and-swap on baseRev.
    const updated = await coll.findOneAndUpdate(
      { _id: DOC_ID, rev: baseRev },
      { $set: { rev: baseRev + 1, updatedAt: now, device, payload } },
      { returnDocument: 'after' }
    );
    if (updated) {
      return jsonRes({ rev: updated.rev, updatedAt: now.toISOString(), device }, 200);
    }
    const cur = await coll.findOne({ _id: DOC_ID });
    if (!cur) {
      // Document deleted by the operator: recreate it so devices are not
      // stuck on an unknown rev.
      await coll.insertOne({ _id: DOC_ID, rev: baseRev + 1, updatedAt: now, device, payload });
      return jsonRes({ rev: baseRev + 1, updatedAt: now.toISOString(), device }, 200);
    }
    return jsonRes({ conflict: true, doc: toWire(cur) }, 409);
  } catch (e) {
    return storeError(e);
  }
}
