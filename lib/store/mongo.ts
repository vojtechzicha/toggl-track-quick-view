// MongoDB connection for the store (standalone mode and settings sync).
//
// One MongoClient promise is cached on globalThis so warm invocations and dev
// reloads reuse the pool. Indexes are ensured during the initial connect, so
// routes can rely on them, including the one that limits the store to one
// running timer.

import { MongoClient, type Db } from 'mongodb';

const DEFAULT_DB = 'toggl-quick-view';

/**
 * MONGODB_URI switches a deployment to standalone mode, unless APP_MODE=toggl,
 * in which case the database only backs settings sync (lib/sync/server.ts).
 */
export function standaloneEnabled(): boolean {
  return !!process.env.MONGODB_URI && process.env.APP_MODE !== 'toggl';
}

async function connect(uri: string): Promise<Db> {
  // Fail fast on an unreachable cluster. The driver's default 30s wait would
  // run into the serverless time limit and hide the config error.
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || DEFAULT_DB);
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('workspaces').createIndex({ numericId: 1 }, { unique: true }),
    db.collection('entries').createIndex({ workspaceId: 1, start: -1 }),
    db.collection('entries').createIndex({ numericId: 1 }, { unique: true }),
    // At most one running entry (stop: null) in the store, enforced by the
    // database so two devices cannot both start a timer.
    db.collection('entries').createIndex(
      { stop: 1 },
      { unique: true, partialFilterExpression: { stop: { $type: 'null' } } }
    ),
    // Imported entries carry their Toggl id, so re-running an import never
    // duplicates.
    db.collection('entries').createIndex({ togglId: 1 }, { unique: true, sparse: true }),
  ]);
}

// On globalThis so it survives dev-mode module reloads. Keyed by URI so a
// changed env var gets a new connection.
const g = globalThis as typeof globalThis & {
  _tqvMongo?: { uri: string; promise: Promise<Db> };
};

export async function getStoreDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!g._tqvMongo || g._tqvMongo.uri !== uri) {
    const promise = connect(uri).catch((e) => {
      // Don't cache a failed connect, or a transient outage lasts until the
      // next cold start.
      if (g._tqvMongo?.promise === promise) g._tqvMongo = undefined;
      throw e;
    });
    g._tqvMongo = { uri, promise };
  }
  return g._tqvMongo.promise;
}
