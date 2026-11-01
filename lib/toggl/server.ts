// Server-side Toggl Track API client (TOGGL_API_TOKEN), for the mirror and
// the MCP tools.
//
// Every response's quota headers are recorded in the database
// (`toggl_quota`), so all serverless instances, the MCP tools and the
// dashboard proxy share one picture of the hourly budget. Toggl documents two
// buckets on the Free plan, 30 requests/hour each: one per user ("/me"
// endpoints) and one per user per organization (workspace endpoints). Which
// bucket /me/time_entries counts against is not documented, so quota is
// recorded per path class as Toggl reports it, never estimated.
//
// Account data (projects, tags) is cached in `toggl_cache` for a day. Time
// entries live in the mirror (lib/mirror), which reads and writes them
// through togglRequestMeta.

import { getStoreDb } from '@/lib/store/mongo';

const TOGGL_BASE = 'https://api.track.toggl.com/api/v9';
export const CREATED_WITH = 'track.zicha.dev MCP';

/** Requests left for the dashboard: writes stop when the bucket is down to this. */
export const QUOTA_RESERVE = 5;

export type QuotaBucket = 'user' | 'workspace';

export interface QuotaSnapshot {
  bucket: QuotaBucket;
  remaining: number;
  /** When Toggl said the window resets (ms epoch). */
  resetsAtMs: number;
  /** When the snapshot was taken (ms epoch). */
  atMs: number;
}

export class TogglError extends Error {
  readonly status: number;
  /** Seconds until the quota resets, for 402/429. */
  readonly resetsInSec: number | null;
  /** The quota the error response reported: refused requests count too. */
  readonly quota: ResponseQuota | null;
  constructor(status: number, message: string, resetsInSec: number | null = null, quota: ResponseQuota | null = null) {
    super(message);
    this.name = 'TogglError';
    this.status = status;
    this.resetsInSec = resetsInSec;
    this.quota = quota;
  }
}

/** No Toggl request runs longer than this (the push lease is sized on it). */
export const TOGGL_TIMEOUT_MS = 20_000;

export function isQuotaError(e: unknown): e is TogglError {
  return e instanceof TogglError && (e.status === 402 || e.status === 429);
}

export function bucketOf(path: string): QuotaBucket {
  return /^\/?me(\/|$|\?)/.test(path) ? 'user' : 'workspace';
}

function authHeader(): string {
  const token = process.env.TOGGL_API_TOKEN;
  if (!token) throw new TogglError(401, 'TOGGL_API_TOKEN is not set on this deployment.');
  return `Basic ${Buffer.from(`${token}:api_token`).toString('base64')}`;
}

/**
 * Record Toggl's quota headers. Fire-and-forget: a database hiccup must never
 * fail the request that carried them. No-op without a database.
 */
export function recordQuota(path: string, headers: Headers): void {
  if (!process.env.MONGODB_URI) return;
  const remaining = Number(headers.get('x-toggl-quota-remaining'));
  const resetsIn = Number(headers.get('x-toggl-quota-resets-in'));
  if (!headers.has('x-toggl-quota-remaining') || !Number.isFinite(remaining)) return;
  const now = Date.now();
  const bucket = bucketOf(path);
  void getStoreDb()
    .then((db) =>
      db.collection<{ _id: string } & Omit<QuotaSnapshot, 'bucket'>>('toggl_quota').updateOne(
        { _id: bucket },
        {
          $set: {
            remaining,
            resetsAtMs: now + (Number.isFinite(resetsIn) ? resetsIn : 3600) * 1000,
            atMs: now,
          },
        },
        { upsert: true }
      )
    )
    .catch((e) => console.error('[toggl quota]', e));
}

/** Last known quota per bucket. A snapshot past its reset time reads as unknown. */
export async function quotaStatus(): Promise<QuotaSnapshot[]> {
  const db = await getStoreDb();
  const rows = await db
    .collection<{ _id: string } & Omit<QuotaSnapshot, 'bucket'>>('toggl_quota')
    .find({})
    .toArray();
  const now = Date.now();
  return rows
    .filter((r) => r.resetsAtMs > now)
    .map((r) => ({ bucket: r._id as QuotaBucket, remaining: r.remaining, resetsAtMs: r.resetsAtMs, atMs: r.atMs }));
}

/** Quota as reported on one response, or null when Toggl sent no headers. */
export interface ResponseQuota {
  remaining: number;
  resetsInSec: number;
}

/** One Toggl request. Throws TogglError on a non-2xx answer. */
export async function togglRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  return (await togglRequestMeta<T>(method, path, body)).data;
}

/** togglRequest plus the quota the response reported. */
export async function togglRequestMeta<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ data: T; quota: ResponseQuota | null }> {
  const res = await fetch(`${TOGGL_BASE}${path.startsWith('/') ? path : `/${path}`}`, {
    method,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    // A hung request must end before the lease guarding it does; a timed-out
    // create counts as possibly sent (lib/mirror/sync.ts).
    signal: AbortSignal.timeout(TOGGL_TIMEOUT_MS),
  });
  recordQuota(path, res.headers);
  const text = await res.text();
  const remaining = Number(res.headers.get('x-toggl-quota-remaining'));
  const resetsIn = Number(res.headers.get('x-toggl-quota-resets-in'));
  const quota: ResponseQuota | null =
    res.headers.has('x-toggl-quota-remaining') && Number.isFinite(remaining)
      ? { remaining, resetsInSec: Number.isFinite(resetsIn) ? resetsIn : 3600 }
      : null;
  if (!res.ok) {
    const detail = text.slice(0, 300).replace(/\s+/g, ' ').trim();
    if (res.status === 402 || res.status === 429) {
      throw new TogglError(
        res.status,
        `Toggl rate limit reached (HTTP ${res.status}).`,
        Number.isFinite(resetsIn) ? resetsIn : null,
        quota
      );
    }
    throw new TogglError(res.status, `Toggl answered HTTP ${res.status}: ${detail || res.statusText}`, null, quota);
  }
  return { data: (text ? JSON.parse(text) : null) as T, quota };
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheDoc {
  _id: string;
  at: Date;
  expires_at: Date;
  value: unknown;
}

let cacheIndexes: Promise<unknown> | null = null;

async function cacheCol() {
  const db = await getStoreDb();
  if (!cacheIndexes) {
    cacheIndexes = Promise.all([
      db.collection('toggl_cache').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 }),
    ]).catch((e) => {
      cacheIndexes = null;
      throw e;
    });
  }
  await cacheIndexes;
  return db.collection<CacheDoc>('toggl_cache');
}

async function cached<T>(
  key: string,
  maxAgeSec: number,
  load: () => Promise<T>
): Promise<{ value: T; atMs: number; cached: boolean }> {
  const col = await cacheCol();
  const hit = await col.findOne({ _id: key });
  if (hit && Date.now() - hit.at.getTime() < maxAgeSec * 1000) {
    return { value: hit.value as T, atMs: hit.at.getTime(), cached: true };
  }
  const value = await load();
  const at = new Date();
  await col.updateOne(
    { _id: key },
    {
      $set: {
        at,
        expires_at: new Date(at.getTime() + 2 * 24 * 3600 * 1000),
        value,
      },
    },
    { upsert: true }
  );
  return { value, atMs: at.getTime(), cached: false };
}

// ─── Account ────────────────────────────────────────────────────────────────

export interface TogglProject {
  id: number;
  name: string;
  active: boolean;
  color?: string;
  client_id?: number | null;
}

export interface TogglTag {
  id: number;
  name: string;
}

export interface TogglAccount {
  fullname: string;
  workspaceId: number;
  projects: TogglProject[];
  tags: TogglTag[];
}

interface MeWithRelated {
  fullname: string;
  default_workspace_id: number;
  projects?: (TogglProject & { workspace_id: number })[] | null;
  tags?: (TogglTag & { workspace_id: number; deleted_at?: string | null })[] | null;
}

const ACCOUNT_TTL_SEC = 24 * 3600;

/** Account, projects and tags of the default workspace: one request, cached for a day. */
export async function getAccount(opts: { refresh?: boolean } = {}) {
  return cached<TogglAccount>('account', opts.refresh ? 0 : ACCOUNT_TTL_SEC, async () => {
    const me = await togglRequest<MeWithRelated>('GET', '/me?with_related_data=true');
    const wid = me.default_workspace_id;
    return {
      fullname: me.fullname ?? '',
      workspaceId: wid,
      projects: (me.projects ?? [])
        .filter((p) => p.workspace_id === wid)
        .map((p) => ({ id: p.id, name: p.name, active: p.active !== false, color: p.color, client_id: p.client_id ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      tags: (me.tags ?? [])
        .filter((t) => t.workspace_id === wid && !t.deleted_at)
        .map((t) => ({ id: t.id, name: t.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

/**
 * Add tags a write introduced (allow_new_tags) to the cached catalog, so the
 * next call accepts them without waiting for the daily refresh. Toggl creates
 * them when the entry is pushed; the next refresh brings their real ids (0
 * until then).
 */
export async function rememberTags(names: string[]): Promise<void> {
  if (names.length === 0) return;
  const col = await cacheCol();
  const hit = await col.findOne({ _id: 'account' });
  if (!hit) return;
  const account = hit.value as TogglAccount;
  const known = new Set(account.tags.map((t) => t.name));
  const added = [...new Set(names)].filter((n) => !known.has(n));
  if (added.length === 0) return;
  const tags = [...account.tags, ...added.map((name) => ({ id: 0, name }))].sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  await col.updateOne({ _id: 'account' }, { $set: { 'value.tags': tags } });
}

/** Remaining requests in a bucket, or null when unknown (no recent response). */
export async function remainingIn(bucket: QuotaBucket): Promise<{ remaining: number; resetsInSec: number } | null> {
  const snap = (await quotaStatus()).find((q) => q.bucket === bucket);
  if (!snap) return null;
  return { remaining: snap.remaining, resetsInSec: Math.max(0, Math.round((snap.resetsAtMs - Date.now()) / 1000)) };
}
