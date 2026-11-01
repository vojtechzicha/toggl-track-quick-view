// Whether settings sync is available: MONGODB_URI (lib/store/mongo.ts) plus
// APP_PASSWORD, since /api/sync writes.

import { getStoreDb } from '@/lib/store/mongo';
import type { SyncPayload } from './model';

export function syncEnabled(): boolean {
  return !!process.env.MONGODB_URI && !!process.env.APP_PASSWORD;
}

/** A sync misconfiguration, or null. */
export function syncMisconfigured(): string | null {
  if (process.env.MONGODB_URI && !process.env.APP_PASSWORD) {
    return 'APP_PASSWORD must be set to use settings sync (the sync store accepts writes).';
  }
  return null;
}

/**
 * The synced settings (active settings, stored workspaces, export details),
 * or null when no device has synced yet. Read by the MCP tools; the sync
 * route owns the writes. Same collection and id as app/api/sync.
 */
export async function readSyncPayload(): Promise<SyncPayload | null> {
  const db = await getStoreDb();
  const doc = await db
    .collection<{ _id: string; payload: SyncPayload }>('settingsSync')
    .findOne({ _id: 'settings' });
  return doc?.payload ?? null;
}
