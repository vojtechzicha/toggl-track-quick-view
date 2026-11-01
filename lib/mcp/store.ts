// Storage for the MCP connector: OAuth clients, codes, grants, tokens and the
// audit log, as plain collections in the app's MongoDB (lib/store/mongo.ts).
// Codes and tokens are stored only as SHA-256 hashes under _id. expires_at is
// a Date, so TTL indexes prune expired rows.
//
// The interface lets scripts/check-mcp.ts swap in an in-memory store.

import crypto from 'node:crypto';
import type { Collection, Db, Document } from 'mongodb';
import { getStoreDb } from '@/lib/store/mongo';

export type Row = Record<string, any>;

export interface McpStore {
  createClient(data: Row): Promise<Row>;
  getClient(id: string): Promise<Row | null>;
  createAuthCode(hash: string, data: Row): Promise<void>;
  consumeAuthCode(hash: string): Promise<Row | null>;
  createGrant(data: Row): Promise<Row>;
  getGrant(id: string): Promise<Row | null>;
  listActiveGrants(): Promise<Row[]>;
  touchGrant(id: string): Promise<void>;
  revokeGrant(id: string): Promise<void>;
  insertToken(hash: string, data: Row): Promise<void>;
  getToken(hash: string): Promise<Row | null>;
  /** Marks an unused refresh token used and returns it, atomically. */
  claimRefreshToken(hash: string): Promise<Row | null>;
  deleteToken(hash: string): Promise<void>;
  insertAudit(data: Row): Promise<void>;
  listAudit(limit: number): Promise<Row[]>;
}

let indexes: Promise<void> | null = null;

function ensureIndexes(db: Db): Promise<void> {
  if (!indexes) {
    indexes = Promise.all([
      db.collection('mcp_auth_codes').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
      db.collection('mcp_tokens').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
      db.collection('mcp_tokens').createIndex({ grant_id: 1 }),
      db.collection('mcp_audit').createIndex({ at: -1 }),
    ])
      .then(() => undefined)
      .catch((err) => {
        indexes = null;
        throw err;
      });
  }
  return indexes;
}

// String _ids (hashes, random hex), so the collections are typed loosely.
type StrDoc = Document & { _id: string };
async function col(name: string): Promise<Collection<StrDoc>> {
  const db = await getStoreDb();
  await ensureIndexes(db);
  return db.collection(name);
}

const newId = () => crypto.randomBytes(12).toString('hex');
const now = () => new Date();

export const mongoStore: McpStore = {
  async createClient(data) {
    const doc = { _id: newId(), ...data, created_at: now() };
    await (await col('mcp_clients')).insertOne(doc);
    return doc;
  },
  async getClient(id) {
    return (await col('mcp_clients')).findOne({ _id: id });
  },
  async createAuthCode(hash, data) {
    await (await col('mcp_auth_codes')).insertOne({ _id: hash, ...data, created_at: now() });
  },
  async consumeAuthCode(hash) {
    return (await col('mcp_auth_codes')).findOneAndDelete({ _id: hash });
  },
  async createGrant(data) {
    const doc = { _id: newId(), ...data, revoked_at: null, last_used_at: null, created_at: now() };
    await (await col('mcp_grants')).insertOne(doc);
    return doc;
  },
  async getGrant(id) {
    return (await col('mcp_grants')).findOne({ _id: id });
  },
  async listActiveGrants() {
    return (await col('mcp_grants')).find({ revoked_at: null }).sort({ created_at: -1 }).toArray();
  },
  async touchGrant(id) {
    await (await col('mcp_grants')).updateOne({ _id: id }, { $set: { last_used_at: now() } });
  },
  async revokeGrant(id) {
    await (await col('mcp_grants')).updateOne(
      { _id: id, revoked_at: null },
      { $set: { revoked_at: now() } }
    );
    await (await col('mcp_tokens')).deleteMany({ grant_id: id });
  },
  async insertToken(hash, data) {
    await (await col('mcp_tokens')).insertOne({ _id: hash, ...data, used_at: null, created_at: now() });
  },
  async getToken(hash) {
    return (await col('mcp_tokens')).findOne({ _id: hash });
  },
  async claimRefreshToken(hash) {
    // Atomic, so two concurrent refreshes can't both succeed.
    return (await col('mcp_tokens')).findOneAndUpdate(
      { _id: hash, kind: 'refresh', used_at: null },
      { $set: { used_at: now() } }
    );
  },
  async deleteToken(hash) {
    await (await col('mcp_tokens')).deleteOne({ _id: hash });
  },
  async insertAudit(data) {
    await (await col('mcp_audit')).insertOne({ _id: newId(), ...data, at: now() });
  },
  async listAudit(limit) {
    return (await col('mcp_audit')).find({}).sort({ at: -1 }).limit(limit).toArray();
  },
};

/** An in-memory store with the same semantics, for scripts/check-mcp.ts. */
export function memoryStore(): McpStore {
  const tables = new Map<string, Map<string, Row>>();
  const t = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  return {
    async createClient(data) {
      const doc = { _id: newId(), ...data, created_at: now() };
      t('clients').set(doc._id, doc);
      return doc;
    },
    async getClient(id) {
      return t('clients').get(id) ?? null;
    },
    async createAuthCode(hash, data) {
      t('codes').set(hash, { _id: hash, ...data });
    },
    async consumeAuthCode(hash) {
      const row = t('codes').get(hash) ?? null;
      t('codes').delete(hash);
      return row;
    },
    async createGrant(data) {
      const doc = { _id: newId(), ...data, revoked_at: null, last_used_at: null, created_at: now() };
      t('grants').set(doc._id, doc);
      return doc;
    },
    async getGrant(id) {
      return t('grants').get(id) ?? null;
    },
    async listActiveGrants() {
      return [...t('grants').values()].filter((g) => !g.revoked_at);
    },
    async touchGrant(id) {
      const g = t('grants').get(id);
      if (g) g.last_used_at = now();
    },
    async revokeGrant(id) {
      const g = t('grants').get(id);
      if (g && !g.revoked_at) g.revoked_at = now();
      for (const [k, v] of t('tokens')) if (v.grant_id === id) t('tokens').delete(k);
    },
    async insertToken(hash, data) {
      t('tokens').set(hash, { _id: hash, ...data, used_at: null });
    },
    async getToken(hash) {
      return t('tokens').get(hash) ?? null;
    },
    async claimRefreshToken(hash) {
      const row = t('tokens').get(hash);
      if (!row || row.kind !== 'refresh' || row.used_at) return null;
      const before = { ...row };
      row.used_at = now();
      return before;
    },
    async deleteToken(hash) {
      t('tokens').delete(hash);
    },
    async insertAudit(data) {
      const doc = { _id: newId(), ...data, at: now() };
      t('audit').set(doc._id, doc);
    },
    async listAudit(limit) {
      return [...t('audit').values()].reverse().slice(0, limit);
    },
  };
}

let active: McpStore = mongoStore;

export function getMcpStore(): McpStore {
  return active;
}

/** Swap the store (checks only); null restores MongoDB. */
export function setMcpStoreForChecks(store: McpStore | null): void {
  active = store ?? mongoStore;
}
