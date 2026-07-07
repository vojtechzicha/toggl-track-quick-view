// MongoDB connection for standalone mode — the app's own store of time entries.
//
// Standard serverless pattern: one MongoClient promise cached on globalThis so
// warm lambda invocations (and Next dev HMR reloads) reuse the connection pool
// instead of opening a fresh one per request. Indexes are ensured once as part
// of the initial connect, so every route can assume they exist — most notably
// the partial unique index that lets the DATABASE guarantee at most one running
// timer, closing the two-devices-start-simultaneously race.

import { MongoClient, type Db } from 'mongodb';

const DEFAULT_DB = 'toggl-quick-view';

/** Presence of MONGODB_URI is what switches a deployment to standalone mode. */
export function standaloneEnabled(): boolean {
  return !!process.env.MONGODB_URI;
}

async function connect(uri: string): Promise<Db> {
  // Fail fast when the cluster is unreachable (wrong URI, Atlas network-access
  // list rejecting the host): the driver's default 30s server-selection wait
  // would push a serverless function toward its execution limit and turn a
  // clear config error into an opaque timeout.
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || DEFAULT_DB);
  await ensureIndexes(db);
  return db;
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection('workspaces').createIndex({ numericId: 1 }, { unique: true }),
    // Range queries (entries overlapping [start, end)) scan per-workspace by
    // recency; the numericId lookup serves the by-id routes.
    db.collection('entries').createIndex({ workspaceId: 1, start: -1 }),
    db.collection('entries').createIndex({ numericId: 1 }, { unique: true }),
    // At most ONE running entry (stop: null) in the whole store, enforced by
    // the database itself so two devices cannot race a second timer in.
    db.collection('entries').createIndex(
      { stop: 1 },
      { unique: true, partialFilterExpression: { stop: { $type: 'null' } } }
    ),
    // The Phase-5 importer stamps each imported entry with its Toggl id so
    // re-running an import never duplicates.
    db.collection('entries').createIndex({ togglId: 1 }, { unique: true, sparse: true }),
  ]);
}

// globalThis (rather than a module-local) so the cache survives Next's dev-mode
// module re-evaluation. Keyed by URI so a changed env var doesn't serve a stale
// connection forever.
const g = globalThis as typeof globalThis & {
  _tqvMongo?: { uri: string; promise: Promise<Db> };
};

export async function getStoreDb(): Promise<Db> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  if (!g._tqvMongo || g._tqvMongo.uri !== uri) {
    const promise = connect(uri).catch((e) => {
      // A failed connect must not be cached, or the store would stay broken
      // until the next cold start even after a transient outage.
      if (g._tqvMongo?.promise === promise) g._tqvMongo = undefined;
      throw e;
    });
    g._tqvMongo = { uri, promise };
  }
  return g._tqvMongo.promise;
}
