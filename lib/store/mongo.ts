// MongoDB connection (MONGODB_URI): settings sync and the MCP connector's
// OAuth and audit collections.
//
// One MongoClient promise is cached on globalThis so warm invocations and dev
// reloads reuse the pool. Each feature ensures its own indexes.

import { MongoClient, type Db } from 'mongodb';

const DEFAULT_DB = 'toggl-quick-view';

async function connect(uri: string): Promise<Db> {
  // Fail fast on an unreachable cluster. The driver's default 30s wait would
  // run into the serverless time limit and hide the config error.
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  // Always an explicit name: preview and production share the connection
  // string, and only MONGODB_DB keeps them apart.
  return client.db(process.env.MONGODB_DB || DEFAULT_DB);
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
