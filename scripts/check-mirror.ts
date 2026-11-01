// Checks for the rules of the local Toggl copy (`pnpm check:mirror`):
// lib/mirror/model.ts. No network, no database. The loop itself (pull, push,
// leases, quota) runs against MongoDB and a fake Toggl in
// scripts/test-mirror.ts (`pnpm test:mirror`).
//
//  - A pull never loses a pending local edit: three-way merge per field group,
//    with a conflict only when both sides changed the same group differently.
//  - A push sends only what Toggl doesn't have.
//  - A lost create is recognised by start minute, project and description.

import assert from 'node:assert/strict';
import { installResolveHooks } from './resolve-hooks.mjs';

installResolveHooks();

const m = await import('../lib/mirror/model.ts');

let checks = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepStrictEqual(a, b, msg);
};
const ok = (c: unknown, msg: string) => {
  checks++;
  assert.ok(c, msg);
};

const remote = (over: Partial<import('../lib/mirror/model.ts').TogglEntry> = {}) => ({
  id: 7,
  workspace_id: 1,
  project_id: 10,
  description: 'Design',
  tags: ['D-1'],
  billable: false,
  start: '2026-10-29T08:00:00+00:00',
  stop: '2026-10-29T10:00:00+00:00',
  duration: 7200,
  at: '2026-10-29T10:00:05+00:00',
  ...over,
});

const base = m.fieldsFromToggl(remote());
const docWith = (fields: typeof base, dirty: boolean) => ({
  fields,
  remote: { ...base, at: '2026-10-29T10:00:05+00:00' },
  dirty,
});

// ─── Normalisation ──────────────────────────────────────────────────────────

eq(base.start, '2026-10-29T08:00:00.000Z', 'start in UTC ISO, second precision');
eq(m.fieldsFromToggl(remote({ stop: null, duration: -1761724800 })).stop, null, 'running entry has no stop');
eq(m.fieldsFromToggl(remote({ description: null, tags: null })), { ...base, description: '', tags: [] }, 'nulls normalised');
eq(m.isoSecond('2026-10-29T08:00:00.987Z'), '2026-10-29T08:00:00.000Z', 'milliseconds dropped');
ok(m.spanOf(m.fieldsFromToggl(remote({ stop: null, duration: -1 }))).end_at.getUTCFullYear() === 9999, 'running entry spans to the far future');

// ─── Merge ──────────────────────────────────────────────────────────────────

{
  // Clean document: Toggl wins wholesale.
  const r = m.mergeRemote(docWith(base, false), remote({ description: 'Design review', at: 'b' }));
  eq([r.fields.description, r.dirty, r.conflicts.length], ['Design review', false, 0], 'clean doc takes Toggl');
}
{
  // Local tags edit pending, Toggl changed the description: both survive, still dirty.
  const local = { ...base, tags: ['D-2'] };
  const r = m.mergeRemote(docWith(local, true), remote({ description: 'Design review', at: 'b' }));
  eq(r.fields.tags, ['D-2'], 'local tags kept');
  eq(r.fields.description, 'Design review', "Toggl's description taken");
  eq(r.dirty, true, 'still dirty: tags not in Toggl yet');
  eq(r.conflicts, [], 'no conflict for different groups');
  eq(r.remote.description, 'Design review', 'base moves to the new remote');
}
{
  // Both changed the description differently: local wins, conflict recorded.
  const local = { ...base, description: 'Mine' };
  const r = m.mergeRemote(docWith(local, true), remote({ description: 'Theirs', at: 'b' }));
  eq(r.fields.description, 'Mine', 'local wins a real conflict');
  eq(r.conflicts.map((c) => [c.field, c.local, c.toggl]), [['description', 'Mine', 'Theirs']], 'conflict recorded');
}
{
  // Both arrived at the same value: no conflict, no longer dirty.
  const local = { ...base, description: 'Same' };
  const r = m.mergeRemote(docWith(local, true), remote({ description: 'Same', at: 'b' }));
  eq([r.dirty, r.conflicts.length], [false, 0], 'convergent edit is clean');
}
{
  // Start/stop/duration merge as one group; tag order does not matter.
  const local = { ...base, start: '2026-10-29T09:00:00.000Z', duration: 3600 };
  const r = m.mergeRemote(docWith(local, true), remote({ tags: ['D-1'], at: 'b' }));
  eq([r.fields.start, r.fields.duration, r.dirty], ['2026-10-29T09:00:00.000Z', 3600, true], 'local time edit kept');
  const reordered = m.mergeRemote(docWith({ ...base, tags: ['B', 'A'] }, true), remote({ tags: ['A', 'B'], at: 'b' }));
  eq([reordered.dirty, reordered.conflicts.length], [false, 0], 'tags compare as a set');
}

// ─── Push bodies ────────────────────────────────────────────────────────────

{
  const doc = { workspace_id: 1, fields: { ...base, tags: ['D-2'], description: 'New' }, remote: { ...base, at: 'a' } };
  eq(m.updateBody(doc), { workspace_id: 1, description: 'New', tags: ['D-2'] }, 'update sends only changed groups');
  const moved = { ...doc, fields: { ...base, start: '2026-10-29T09:00:00.000Z', stop: '2026-10-29T10:00:00.000Z', duration: 3600 } };
  eq(
    m.updateBody(moved),
    { workspace_id: 1, start: '2026-10-29T09:00:00.000Z', stop: '2026-10-29T10:00:00.000Z', duration: 3600 },
    'a time change sends start, stop and duration together'
  );
  const create = m.createBody({ workspace_id: 1, fields: base }, 'test') as Record<string, unknown>;
  eq([create.created_with, create.stop, create.duration, create.tags], ['test', base.stop, 7200, ['D-1']], 'create body');
}

// ─── Lost creates, status, ids ──────────────────────────────────────────────

{
  const local = { fields: { ...base, start: '2026-10-29T08:00:00.000Z' } };
  ok(m.matchesInFlight(local, remote({ start: '2026-10-29T08:00:41+00:00' })), 'same minute matches');
  ok(!m.matchesInFlight(local, remote({ description: 'Other' })), 'other description does not');
  ok(!m.matchesInFlight(local, remote({ project_id: 11 })), 'other project does not');

  const st = (o: object) =>
    m.statusOf({ dirty: false, push: { ...m.EMPTY_PUSH }, remote_deleted: false, conflicts: [], toggl_id: 1, ...o } as never);
  eq(st({}), 'synced', 'synced');
  eq(st({ dirty: true }), 'pending', 'pending edit');
  eq(st({ toggl_id: null, dirty: true }), 'pending', 'pending create');
  eq(st({ dirty: true, push: { ...m.EMPTY_PUSH, failed: true } }), 'failed', 'failed');
  eq(st({ remote_deleted: true }), 'conflict', 'deleted in Toggl');
  eq(m.publicId({ toggl_id: null, local_seq: 4 }), -4, 'local entries have negative ids');
  eq(m.publicId({ toggl_id: 99, local_seq: 4 }), 99, "Toggl's id once it has one");
}

console.log(`✓ ${checks} mirror checks passed`);
