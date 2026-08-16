// Cross-device settings sync: one revisioned document per deployment.
//
// GET  → { doc: SyncDoc | null }                       (null = never synced)
// PUT  { baseRev, device, payload } →
//        200 { rev, updatedAt, device }                 (write accepted)
//        409 { conflict: true, doc: SyncDoc }           (baseRev is stale)
//
// The rev check is what makes multi-device editing safe: a device may only
// replace the revision it last saw. `baseRev: null` means "I have never
// synced" and only ever CREATES the document — if one already exists the
// insert loses the race and the caller gets the current document back as a
// 409, so a fresh device can never wipe an established setup.
//
// Mode-independent: works in standalone mode and in Toggl mode with
// APP_MODE=toggl + MONGODB_URI. Writes require the password gate, exactly
// like the store routes (see lib/store/guard.ts for the philosophy).

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

/** Mirror of storeGuard, minus the standalone-mode requirement. */
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
  // Defense in depth: a credential must never reach the sync store, even from
  // a buggy or tampered client. refreshSec likewise stays per-device.
  delete (payload.settings as Record<string, unknown>).token;
  delete (payload.settings as Record<string, unknown>).refreshSec;

  try {
    const db = await getStoreDb();
    const coll = db.collection<SyncDbDoc>(COLLECTION);
    const now = new Date();

    if (baseRev === null) {
      // First sync from this device: create the document — never overwrite.
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

    // Atomic compare-and-swap on the revision the device last saw.
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
      // The document vanished (wiped by the operator) — recreate rather than
      // strand every device on a rev the server no longer knows.
      await coll.insertOne({ _id: DOC_ID, rev: baseRev + 1, updatedAt: now, device, payload });
      return jsonRes({ rev: baseRev + 1, updatedAt: now.toISOString(), device }, 200);
    }
    return jsonRes({ conflict: true, doc: toWire(cur) }, 409);
  } catch (e) {
    return storeError(e);
  }
}
