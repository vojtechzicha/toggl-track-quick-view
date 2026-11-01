// MongoDB storage for the mirror: `mirror_entries` (one document per entry,
// lib/mirror/model.ts) and `mirror_state` (pull bookmark, coverage, leases,
// the local id counter).

import crypto from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import { getStoreDb } from '@/lib/store/mongo';
import { EMPTY_PUSH, spanOf, type EntryFields, type MirrorDoc } from './model';

export interface MirrorState {
  _id: 'toggl';
  /** The mirror holds every entry starting in [covered_from_ms, covered_to_ms) (ms epoch). */
  covered_from_ms: number;
  covered_to_ms: number;
  /** Next incremental pull asks for changes since this (ms epoch). */
  since_ms: number;
  last_pull_at: Date | null;
  last_push_at: Date | null;
  last_reconcile_at: Date | null;
  last_error: string | null;
  local_seq: number;
}

interface Lease {
  _id: string;
  until: Date;
  owner: string;
}

let indexes: Promise<unknown> | null = null;

async function db(): Promise<Db> {
  const d = await getStoreDb();
  if (!indexes) {
    const c = d.collection('mirror_entries');
    indexes = Promise.all([
      c.createIndex({ toggl_id: 1 }, { unique: true, partialFilterExpression: { toggl_id: { $type: 'number' } } }),
      c.createIndex({ local_seq: 1 }, { unique: true, partialFilterExpression: { local_seq: { $type: 'number' } } }),
      c.createIndex({ start_at: 1 }),
      c.createIndex({ dirty: 1, updated_at: 1 }),
    ]).catch((e) => {
      indexes = null;
      throw e;
    });
  }
  await indexes;
  return d;
}

export async function entriesCol(): Promise<Collection<MirrorDoc>> {
  return (await db()).collection<MirrorDoc>('mirror_entries');
}

async function stateCol(): Promise<Collection<MirrorState>> {
  return (await db()).collection<MirrorState>('mirror_state');
}

async function leaseCol(): Promise<Collection<Lease>> {
  return (await db()).collection<Lease>('mirror_state') as unknown as Collection<Lease>;
}

// ─── State ──────────────────────────────────────────────────────────────────

/** The mirror's state, or null before the first fill. */
export async function getState(): Promise<MirrorState | null> {
  return (await stateCol()).findOne({ _id: 'toggl' });
}

export async function setState(patch: Partial<Omit<MirrorState, '_id' | 'local_seq'>>): Promise<void> {
  await (await stateCol()).updateOne({ _id: 'toggl' }, { $set: patch }, { upsert: true });
}

export async function nextLocalSeq(): Promise<number> {
  const res = await (await stateCol()).findOneAndUpdate(
    { _id: 'toggl' },
    { $inc: { local_seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return res!.local_seq;
}

// ─── Leases ─────────────────────────────────────────────────────────────────

/**
 * Take a named lease for `ms`, so only one instance pulls or pushes at a
 * time. Returns a release function, or null when someone else holds it.
 */
export async function acquireLease(name: string, ms: number): Promise<(() => Promise<void>) | null> {
  const col = await leaseCol();
  const owner = crypto.randomBytes(8).toString('hex');
  const now = new Date();
  try {
    const res = await col.findOneAndUpdate(
      { _id: `lease:${name}`, until: { $lt: now } },
      { $set: { until: new Date(now.getTime() + ms), owner } },
      { upsert: true, returnDocument: 'after' }
    );
    if (!res || res.owner !== owner) return null;
  } catch (e) {
    // Upsert raced with a live lease: the filter missed, the insert collided.
    if ((e as { code?: number }).code === 11000) return null;
    throw e;
  }
  return async () => {
    await col.updateOne({ _id: `lease:${name}`, owner }, { $set: { until: new Date(0) } });
  };
}

// ─── Entries ────────────────────────────────────────────────────────────────

export async function byTogglId(id: number): Promise<MirrorDoc | null> {
  return (await entriesCol()).findOne({ toggl_id: id });
}

/** By the public id: Toggl's id, or the negative local number. */
export async function byPublicId(id: number): Promise<MirrorDoc | null> {
  const col = await entriesCol();
  return id > 0 ? col.findOne({ toggl_id: id }) : col.findOne({ local_seq: -id });
}

/** Entries overlapping [fromMs, toMs). */
export async function inRange(fromMs: number, toMs: number): Promise<MirrorDoc[]> {
  return (await entriesCol())
    .find({ start_at: { $lt: new Date(toMs) }, end_at: { $gt: new Date(fromMs) } })
    .sort({ start_at: 1 })
    .toArray();
}

/** A new document for an entry first seen in Toggl. */
export function docFromRemote(
  togglId: number,
  workspaceId: number,
  fields: EntryFields,
  at: string
): MirrorDoc {
  const now = new Date();
  return {
    _id: `t:${togglId}`,
    toggl_id: togglId,
    local_seq: null,
    workspace_id: workspaceId,
    fields,
    remote: { ...fields, at },
    dirty: false,
    version: 0,
    remote_deleted: false,
    conflicts: [],
    push: { ...EMPTY_PUSH },
    ...spanOf(fields),
    origin: 'toggl',
    created_at: now,
    updated_at: now,
  };
}

/** A new document for an entry created here, waiting to be pushed. */
export async function docFromLocal(workspaceId: number, fields: EntryFields): Promise<MirrorDoc> {
  const seq = await nextLocalSeq();
  const now = new Date();
  return {
    _id: `l:${seq}`,
    toggl_id: null,
    local_seq: seq,
    workspace_id: workspaceId,
    fields,
    remote: null,
    dirty: true,
    version: 1,
    remote_deleted: false,
    conflicts: [],
    push: { ...EMPTY_PUSH },
    ...spanOf(fields),
    origin: 'local',
    created_at: now,
    updated_at: now,
  };
}

export interface QueueStatus {
  pending: number;
  failed: number;
  conflicts: number;
  oldest_pending_at: Date | null;
}

export async function queueStatus(): Promise<QueueStatus> {
  const col = await entriesCol();
  const [pending, failed, conflicts, oldest] = await Promise.all([
    col.countDocuments({ dirty: true, 'push.failed': false, remote_deleted: false }),
    col.countDocuments({ 'push.failed': true }),
    col.countDocuments({ $or: [{ remote_deleted: true }, { 'conflicts.0': { $exists: true } }] }),
    col
      .find({ dirty: true, 'push.failed': false, remote_deleted: false })
      .sort({ updated_at: 1 })
      .limit(1)
      .next(),
  ]);
  return { pending, failed, conflicts, oldest_pending_at: oldest?.updated_at ?? null };
}
