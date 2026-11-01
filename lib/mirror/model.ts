// The local copy of the Toggl time entries ("mirror"), and the pure rules for
// keeping it and Toggl in step. No I/O here, so scripts/check-mirror.ts can
// test every rule. Storage: lib/mirror/store.ts. The loop: lib/mirror/sync.ts.
//
// Each document holds the entry as the app sees it (`fields`) and, once Toggl
// has it, the last state Toggl confirmed (`remote`). `dirty` means the two
// differ in a way Toggl has not seen yet; the pusher sends exactly that
// difference. A pull merges Toggl's newer state in three ways against
// `remote` as the common base, so a pending local edit is never lost to an
// unrelated change made in Toggl.

import type { TimeEntry } from '@/lib/calc';

/** What Toggl sends for one entry (the fields the mirror uses). */
export interface TogglEntry {
  id: number;
  workspace_id: number;
  project_id: number | null;
  description?: string | null;
  tags?: string[] | null;
  billable?: boolean;
  start: string;
  stop: string | null;
  duration: number; // negative while running
  at: string; // last modified
  server_deleted_at?: string | null;
}

/** The parts of an entry the app edits and Toggl stores. */
export interface EntryFields {
  project_id: number | null;
  description: string;
  tags: string[];
  billable: boolean;
  start: string; // UTC ISO, second precision
  stop: string | null; // null while running
  duration: number; // seconds; negative while running
}

export interface FieldConflict {
  field: FieldGroup;
  local: unknown;
  toggl: unknown;
  at: string;
}

export interface MirrorDoc {
  _id: string;
  /** Toggl's id; null until the entry has been created in Toggl. */
  toggl_id: number | null;
  /** For entries created here: a small number, shown as the negative id until Toggl assigns one. */
  local_seq: number | null;
  workspace_id: number;
  fields: EntryFields;
  /** The last state Toggl confirmed, with its `at`. Null until created in Toggl. */
  remote: (EntryFields & { at: string }) | null;
  /** fields ≠ remote in a way Toggl has not seen yet. */
  dirty: boolean;
  /** Bumped by every local edit, so the pusher never clears a newer edit. */
  version: number;
  /** Toggl deleted the entry while a local edit was pending. Not pushed until resolved. */
  remote_deleted: boolean;
  /** Fields changed on both sides since the last sync; the local value was kept. */
  conflicts: FieldConflict[];
  push: PushState;
  /** For range queries: start, and stop (far future while running). */
  start_at: Date;
  end_at: Date;
  origin: 'toggl' | 'local';
  created_at: Date;
  updated_at: Date;
}

export interface PushState {
  attempts: number;
  last_error: string | null;
  last_attempt_at: Date | null;
  /** A create was sent at this time and its answer not yet stored (see adoption in sync.ts). */
  in_flight_since: Date | null;
  /**
   * What identifies that create in Toggl, as sent. Adoption matches on this,
   * not on the current fields, which may have been edited since.
   */
  sent: Pick<EntryFields, 'start' | 'project_id' | 'description'> | null;
  /** Toggl refused it three times; skipped until edited again. */
  failed: boolean;
}

export const EMPTY_PUSH: PushState = {
  attempts: 0,
  last_error: null,
  last_attempt_at: null,
  in_flight_since: null,
  sent: null,
  failed: false,
};

/** A failed create or update is retried this many times before it is parked. */
export const MAX_PUSH_ATTEMPTS = 3;

const FAR_FUTURE = new Date('9999-12-31T00:00:00Z');

/** Second precision, so Toggl's and our spelling of the same instant compare equal. */
export function isoSecond(v: string | number | Date): string {
  const ms = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : v.getTime();
  return new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

export function fieldsFromToggl(e: TogglEntry): EntryFields {
  const running = e.duration < 0 || !e.stop;
  return {
    project_id: e.project_id ?? null,
    description: (e.description ?? '').trim(),
    tags: [...(e.tags ?? [])],
    billable: !!e.billable,
    start: isoSecond(e.start),
    stop: running ? null : isoSecond(e.stop!),
    duration: running ? -1 : e.duration,
  };
}

/** start_at / end_at for range queries. */
export function spanOf(f: EntryFields): { start_at: Date; end_at: Date } {
  const start = new Date(f.start);
  if (!f.stop) return { start_at: start, end_at: FAR_FUTURE };
  return { start_at: start, end_at: new Date(f.stop) };
}

// ─── Field groups ───────────────────────────────────────────────────────────

/** Merge units. Start, stop and duration change together, so they merge as one. */
export type FieldGroup = 'project_id' | 'description' | 'tags' | 'billable' | 'time';

export const FIELD_GROUPS: FieldGroup[] = ['project_id', 'description', 'tags', 'billable', 'time'];

function groupValue(f: EntryFields, g: FieldGroup): unknown {
  switch (g) {
    case 'time':
      // A running entry's duration is meaningless; start and "running" are what count.
      return f.stop ? [f.start, f.stop] : [f.start, null];
    case 'tags':
      return [...f.tags].sort();
    default:
      return f[g];
  }
}

function setGroup(target: EntryFields, source: EntryFields, g: FieldGroup): void {
  if (g === 'time') {
    target.start = source.start;
    target.stop = source.stop;
    target.duration = source.duration;
  } else if (g === 'tags') {
    target.tags = [...source.tags];
  } else {
    (target as unknown as Record<string, unknown>)[g] = source[g];
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function groupEqual(a: EntryFields, b: EntryFields, g: FieldGroup): boolean {
  return same(groupValue(a, g), groupValue(b, g));
}

/** Groups in which `a` and `b` differ. */
export function changedGroups(a: EntryFields, b: EntryFields): FieldGroup[] {
  return FIELD_GROUPS.filter((g) => !groupEqual(a, b, g));
}

// ─── Merging a pulled state ─────────────────────────────────────────────────

export interface MergeResult {
  fields: EntryFields;
  remote: EntryFields & { at: string };
  dirty: boolean;
  /** New conflicts (both sides changed the same group differently). */
  conflicts: FieldConflict[];
}

/**
 * Merge Toggl's newer state into a document. Per group:
 *  - unchanged here since the last sync → take Toggl's;
 *  - changed here, not in Toggl → keep ours (still to push);
 *  - changed on both sides → keep ours, and record a conflict unless both
 *    sides arrived at the same value.
 * A clean document (not dirty) simply takes Toggl's state.
 */
export function mergeRemote(
  doc: Pick<MirrorDoc, 'fields' | 'remote' | 'dirty'>,
  incoming: TogglEntry
): MergeResult {
  const theirs = fieldsFromToggl(incoming);
  const remote = { ...theirs, at: incoming.at };
  if (!doc.dirty || !doc.remote) {
    return { fields: { ...theirs, tags: [...theirs.tags] }, remote, dirty: false, conflicts: [] };
  }
  const base = doc.remote;
  const fields: EntryFields = { ...doc.fields, tags: [...doc.fields.tags] };
  const conflicts: FieldConflict[] = [];
  for (const g of FIELD_GROUPS) {
    const localChanged = !groupEqual(doc.fields, base, g);
    const remoteChanged = !groupEqual(theirs, base, g);
    if (!localChanged) {
      setGroup(fields, theirs, g);
    } else if (remoteChanged && !groupEqual(doc.fields, theirs, g)) {
      conflicts.push({
        field: g,
        local: groupValue(doc.fields, g),
        toggl: groupValue(theirs, g),
        at: incoming.at,
      });
    }
  }
  return { fields, remote, dirty: changedGroups(fields, theirs).length > 0, conflicts };
}

// ─── Pushing ────────────────────────────────────────────────────────────────

/** The body of a create. */
export function createBody(doc: Pick<MirrorDoc, 'fields' | 'workspace_id'>, createdWith: string) {
  const f = doc.fields;
  return {
    created_with: createdWith,
    workspace_id: doc.workspace_id,
    project_id: f.project_id,
    description: f.description,
    tags: f.tags,
    billable: f.billable,
    start: f.start,
    ...(f.stop ? { stop: f.stop, duration: f.duration } : { duration: -1 }),
  };
}

/** The body of an update: only the groups that differ from what Toggl has. */
export function updateBody(doc: Pick<MirrorDoc, 'fields' | 'remote' | 'workspace_id'>) {
  if (!doc.remote) throw new Error('updateBody needs a remote state');
  const body: Record<string, unknown> = { workspace_id: doc.workspace_id };
  for (const g of changedGroups(doc.fields, doc.remote)) {
    if (g === 'time') {
      body.start = doc.fields.start;
      if (doc.fields.stop) {
        body.stop = doc.fields.stop;
        body.duration = doc.fields.duration;
      }
    } else if (g === 'tags') {
      body.tags = doc.fields.tags;
    } else {
      body[g] = doc.fields[g];
    }
  }
  return body;
}

/**
 * Whether a remote entry Toggl reports is the create we sent but never heard
 * back from: same start minute, project and description.
 */
export function matchesInFlight(
  doc: Pick<MirrorDoc, 'fields'> & { push?: Pick<PushState, 'sent'> },
  e: TogglEntry
): boolean {
  const theirs = fieldsFromToggl(e);
  const sent = doc.push?.sent ?? doc.fields;
  return (
    Math.floor(Date.parse(theirs.start) / 60000) === Math.floor(Date.parse(sent.start) / 60000) &&
    theirs.project_id === sent.project_id &&
    theirs.description === sent.description
  );
}

// ─── Reading ────────────────────────────────────────────────────────────────

export type SyncStatus = 'synced' | 'pending' | 'failed' | 'conflict';

export function statusOf(doc: Pick<MirrorDoc, 'dirty' | 'push' | 'remote_deleted' | 'conflicts' | 'toggl_id'>): SyncStatus {
  if (doc.remote_deleted || doc.conflicts.length > 0) return 'conflict';
  if (doc.push.failed) return 'failed';
  if (doc.dirty || doc.toggl_id === null) return 'pending';
  return 'synced';
}

/** The id tools and the dashboard use: Toggl's, or the negative local number. */
export function publicId(doc: Pick<MirrorDoc, 'toggl_id' | 'local_seq'>): number {
  return doc.toggl_id ?? -(doc.local_seq ?? 0);
}

/** The entry in the shape lib/calc.ts and the timesheet builders consume. */
export function toTimeEntry(doc: MirrorDoc): TimeEntry {
  const f = doc.fields;
  return {
    id: publicId(doc),
    start: f.start,
    stop: f.stop,
    duration: f.stop ? f.duration : -Math.floor(Date.parse(f.start) / 1000),
    project_id: f.project_id,
    workspace_id: doc.workspace_id,
    description: f.description,
    tags: f.tags,
  };
}
