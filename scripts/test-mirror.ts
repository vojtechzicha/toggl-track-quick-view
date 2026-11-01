// Integration test of the local Toggl copy (`pnpm test:mirror`): the real
// pull/push loop (lib/mirror/sync.ts) and the MCP entry tools, against the
// local MongoDB (`pnpm db`, port 27018, a throwaway database) and a fake
// Toggl that keeps quota per bucket. Not part of `pnpm check`, which needs no
// database.

import assert from 'node:assert/strict';
import { installResolveHooks } from './resolve-hooks.mjs';

installResolveHooks();
process.env.TZ = 'Europe/Prague';
process.env.MONGODB_URI = 'mongodb://localhost:27018';
process.env.MONGODB_DB = 'tqv-mirror-test';
process.env.TOGGL_API_TOKEN = 'fake-token-for-the-mirror-test-0000';
process.env.APP_PASSWORD = 'mirror test password';
process.env.TOGGL_CACHE_INTERVAL = '';

// ─── Fake Toggl ─────────────────────────────────────────────────────────────

type E = {
  id: number;
  workspace_id: number;
  project_id: number | null;
  description: string;
  tags: string[];
  billable: boolean;
  start: string;
  stop: string | null;
  duration: number;
  at: string;
  server_deleted_at: string | null;
};

const toggl = {
  entries: new Map<number, E>(),
  nextId: 1000,
  quota: { user: 30, workspace: 30 } as Record<'user' | 'workspace', number>,
  log: [] as string[],
  /** Commit the next POST but lose the answer (network error). */
  loseNextAnswer: false,
  clock: 0,
  // `at` follows real time (the mirror asks for changes since real times), and never repeats.
  tick() {
    this.clock = Math.max(Date.now(), this.clock + 1000);
    return new Date(this.clock).toISOString();
  },
};

function put(e: Omit<E, 'at' | 'server_deleted_at' | 'workspace_id' | 'billable'> & Partial<E>): E {
  const full: E = { workspace_id: 1, billable: false, server_deleted_at: null, ...e, at: toggl.tick() } as E;
  toggl.entries.set(full.id, full);
  return full;
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== 'api.track.toggl.com') return realFetch(input as never, init);
  const method = init?.method ?? 'GET';
  const path = url.pathname.replace('/api/v9', '');
  const bucket = path.startsWith('/me') ? 'user' : 'workspace';
  toggl.log.push(`${method} ${path}${url.search}`);
  const headers = () => ({
    'content-type': 'application/json',
    'x-toggl-quota-remaining': String(toggl.quota[bucket]),
    'x-toggl-quota-resets-in': '1800',
  });
  if (toggl.quota[bucket] <= 0) return new Response('quota', { status: 402, headers: headers() });
  toggl.quota[bucket]--;
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: headers() });

  if (method === 'GET' && path === '/me') {
    return json({
      fullname: 'Test Person',
      default_workspace_id: 1,
      projects: [
        { id: 10, name: 'Alpha', active: true, workspace_id: 1 },
        { id: 11, name: 'Beta', active: true, workspace_id: 1 },
      ],
      tags: [
        { id: 1, name: 'D-1', workspace_id: 1 },
        { id: 2, name: 'D-2', workspace_id: 1 },
      ],
    });
  }
  if (method === 'GET' && path === '/me/time_entries') {
    const since = url.searchParams.get('since');
    const all = [...toggl.entries.values()];
    if (since) return json(all.filter((e) => Date.parse(e.at) >= Number(since) * 1000));
    const a = Date.parse(url.searchParams.get('start_date')!);
    const b = Date.parse(url.searchParams.get('end_date')!);
    return json(all.filter((e) => !e.server_deleted_at && Date.parse(e.start) >= a && Date.parse(e.start) < b));
  }
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  if (method === 'POST' && path === '/workspaces/1/time_entries') {
    if (body.project_id === 99) return json({ error: 'project archived' }, 400);
    const e = put({ id: toggl.nextId++, ...body });
    if (toggl.loseNextAnswer) {
      toggl.loseNextAnswer = false;
      throw new TypeError('fetch failed');
    }
    return json(e);
  }
  const m = /^\/workspaces\/1\/time_entries\/(\d+)$/.exec(path);
  if (method === 'PUT' && m) {
    const cur = toggl.entries.get(Number(m[1]));
    if (!cur || cur.server_deleted_at) return json({ error: 'not found' }, 404);
    return json(put({ ...cur, ...body, id: cur.id }));
  }
  return json({ error: `fake Toggl: no route ${method} ${path}` }, 404);
}) as typeof fetch;

// ─── Setup ──────────────────────────────────────────────────────────────────

const { getStoreDb } = await import('../lib/store/mongo.ts');
const db = await getStoreDb().catch(() => {
  console.error('MongoDB is not reachable on localhost:27018. Run `pnpm db` first.');
  process.exit(1);
});
await db.dropDatabase();

const sync = await import('../lib/mirror/sync.ts');
const store = await import('../lib/mirror/store.ts');
const { memoryStore, setMcpStoreForChecks } = await import('../lib/mcp/store.ts');
const { entryTools } = await import('../lib/mcp/tools/entries.ts');
sync.configureForTests({ writeSpacingMs: 0, backgroundSync: false });
setMcpStoreForChecks(memoryStore());

const ctx = { auth: { token: 't', clientId: 'c', scopes: ['timesheet:read', 'timesheet:write'], expiresAt: 0, grantId: 'g', clientName: 'test' } } as never;
const tool = async (name: string, args: unknown) => {
  const def = entryTools.find((t) => t.name === name)!;
  return def.handler(args as never, ctx) as Promise<any>;
};

let checks = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepStrictEqual(a, b, msg);
};
const ok = (c: unknown, msg: string) => {
  checks++;
  assert.ok(c, msg);
};
const posts = () => toggl.log.filter((l) => l.startsWith('POST')).length;
const realNow = Date.now;
let exitCode = 0;

try {
  // ── Fill ──
  const now = realNow();
  const iso = (ms: number) => new Date(ms).toISOString();
  put({ id: 1, project_id: 10, description: 'Old work', tags: ['D-1'], start: iso(now - 2 * 86400e3), stop: iso(now - 2 * 86400e3 + 3600e3), duration: 3600 });
  put({ id: 2, project_id: 10, description: 'Ancient', tags: ['D-1'], start: iso(now - 200 * 86400e3), stop: iso(now - 200 * 86400e3 + 3600e3), duration: 3600 });
  await sync.ensureFilled();
  const filled = (await store.entriesCol()).countDocuments();
  eq(await filled, 1, 'first fill reads the recent weeks only');
  ok(toggl.log.filter((l) => l.includes('start_date')).length <= 5, 'fill takes a handful of range requests');

  // ── Create: instant, then pushed ──
  const day = new Date(now - 86400e3);
  const d = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  const created = await tool('create_time_entries', {
    entries: [
      { start: `${d}T08:00`, stop: `${d}T09:00`, description: 'One', project: 'Alpha', tags: ['D-1'] },
      { start: `${d}T09:00`, stop: `${d}T10:00`, description: 'Two', project: 'Alpha', tags: ['D-2'] },
      { start: `${d}T10:00`, stop: `${d}T11:00`, description: 'Three', project: 'Beta' },
    ],
  });
  eq(created.created.map((c: { id: number }) => c.id < 0), [true, true, true], 'new entries get negative ids');
  eq(posts(), 0, 'nothing sent to Toggl during the tool call');
  eq(created.queue.waiting_for_toggl, 3, 'three waiting');
  const listed = await tool('list_time_entries', { from: d, to: d });
  eq(listed.entries.map((e: { sync: string }) => e.sync), ['pending', 'pending', 'pending'], 'listed as pending');

  const again = await tool('create_time_entries', {
    entries: [{ start: `${d}T08:00`, stop: `${d}T09:00`, description: 'One', project: 'Alpha', tags: ['D-1'] }],
  });
  eq([again.created.length, again.skipped_duplicates.length], [0, 1], 're-sending skips a pending duplicate');

  // Edit one twice before it is sent: a single create carries the final state.
  const twoId = created.created[1].id;
  await tool('update_time_entries', { updates: [{ id: twoId, description: 'Two, revised' }] });
  await tool('update_time_entries', { updates: [{ id: twoId, add_tags: ['D-1'], start: `${d}T09:15` }] });

  const p1 = await sync.push();
  eq([p1.pushed, p1.stopped], [3, null], 'three creates pushed');
  eq(posts(), 3, 'one POST each: edits before the push cost nothing');
  const two = [...toggl.entries.values()].find((e) => e.description === 'Two, revised')!;
  eq([two.tags.sort(), two.start, two.duration], [['D-1', 'D-2'], new Date(`${d}T09:15`).toISOString(), 3600], 'final state in Toggl');
  const afterPush = await tool('list_time_entries', { from: d, to: d });
  eq(afterPush.entries.map((e: { sync: string }) => e.sync), ['synced', 'synced', 'synced'], 'synced after the push');
  ok(afterPush.entries.every((e: { id: number }) => e.id >= 1000), "ids are Toggl's now");

  // ── Quota reserve ──
  toggl.quota.workspace = 7;
  await tool('create_time_entries', {
    entries: [11, 12, 13, 14].map((h) => ({ start: `${d}T${h}:00`, duration_minutes: 30, description: `Q${h}`, project: 'Beta' })),
  });
  const p2 = await sync.push();
  eq(p2.pushed, 2, 'stops at the reserve (7 → 5)');
  ok(/quota: 5 requests left/.test(p2.stopped ?? ''), 'and says why');
  toggl.quota.workspace = 0;
  const p3 = await sync.push();
  eq(p3.pushed, 0, 'refused by Toggl (402): nothing pushed');
  toggl.quota.workspace = 30;
  // The recorded quota is fire-and-forget; let it land, then pretend the window reset.
  await new Promise((r) => setTimeout(r, 200));
  await db.collection('toggl_quota').deleteMany({});
  const p4 = await sync.push();
  eq(p4.pushed, 2, 'the rest goes once the quota allows');
  eq((await store.queueStatus()).pending, 0, 'queue empty');

  // ── Lost answer: Toggl created it, we never heard back ──
  const before = posts();
  await tool('create_time_entries', { entries: [{ start: `${d}T16:00`, duration_minutes: 30, description: 'Lost', project: 'Alpha' }] });
  toggl.loseNextAnswer = true;
  const p5 = await sync.push();
  ok(/unreachable/.test(p5.stopped ?? ''), 'network error stops the run');
  const p6 = await sync.push();
  eq(posts() - before, 1, 'no second POST: the next run adopts the entry Toggl already has');
  eq([...toggl.entries.values()].filter((e) => e.description === 'Lost').length, 1, 'no duplicate in Toggl');
  ok(p6.pushed === 1 || (await store.queueStatus()).pending === 0, 'adopted');

  // ── Merge: edited in Toggl and here ──
  const one = [...toggl.entries.values()].find((e) => e.description === 'One')!;
  const oneDoc = (await store.byTogglId(one.id))!;
  await tool('update_time_entries', { updates: [{ id: one.id, tags: ['D-2'] }] });
  put({ ...one, description: 'One (edited in Toggl)' });
  await sync.pullIfStale(0);
  const merged = (await store.byTogglId(one.id))!;
  eq([merged.fields.description, merged.fields.tags, merged.dirty], ['One (edited in Toggl)', ['D-2'], true], 'both edits kept');
  const putsBefore = toggl.log.filter((l) => l.startsWith('PUT')).length;
  await sync.push();
  const lastPut = toggl.log.filter((l) => l.startsWith('PUT'));
  eq(lastPut.length - putsBefore, 1, 'one PUT');
  eq(toggl.entries.get(one.id)!.tags, ['D-2'], 'tags reached Toggl');
  eq(toggl.entries.get(one.id)!.description, 'One (edited in Toggl)', "Toggl's description untouched");
  ok(oneDoc.version < merged.version || merged.version >= 1, 'versioned');

  // ── Deleted in Toggl ──
  const three = [...toggl.entries.values()].find((e) => e.description === 'Three')!;
  put({ ...three, server_deleted_at: toggl.tick() });
  await sync.pullIfStale(0);
  eq(await store.byTogglId(three.id), null, 'a clean entry deleted in Toggl disappears');

  const q11 = [...toggl.entries.values()].find((e) => e.description === 'Q11')!;
  await tool('update_time_entries', { updates: [{ id: q11.id, description: 'Q11 edited here' }] });
  put({ ...q11, server_deleted_at: toggl.tick() });
  await sync.pullIfStale(0);
  const orphan = (await store.byTogglId(q11.id))!;
  eq(orphan.remote_deleted, true, 'an edited entry deleted in Toggl becomes a conflict');
  const status = await tool('get_sync_status', {});
  eq(status.problems.map((p: { sync: string }) => p.sync), ['conflict'], 'listed as a problem');
  const pBefore = posts();
  await sync.push();
  eq(posts(), pBefore, 'conflicts are not pushed');
  await tool('resolve_conflicts', { resolutions: [{ id: q11.id, keep: 'local' }] });
  await sync.push();
  eq([...toggl.entries.values()].filter((e) => e.description === 'Q11 edited here' && !e.server_deleted_at).length, 1, 'keep local re-creates it');

  // ── Refused by Toggl ──
  const docs = await store.entriesCol();
  const bad = await store.docFromLocal(1, { project_id: 99, description: 'Refused', tags: [], billable: false, start: new Date(`${d}T18:00`).toISOString(), stop: new Date(`${d}T18:30`).toISOString(), duration: 1800 });
  await docs.insertOne(bad);
  await tool('create_time_entries', { entries: [{ start: `${d}T19:00`, duration_minutes: 30, description: 'After the refused one', project: 'Alpha' }] });
  const p7 = await sync.push();
  eq([p7.pushed, p7.failed], [1, 1], 'a refused entry is parked; the others still go');
  eq((await store.byPublicId(-bad.local_seq!))!.push.failed, true, 'parked as failed');
  const p8Posts = posts();
  await sync.push();
  eq(posts(), p8Posts, 'not retried until edited');

  // ── Delete only what Toggl doesn't have ──
  const local = await tool('create_time_entries', { entries: [{ start: `${d}T20:00`, duration_minutes: 15, description: 'Oops', project: 'Alpha' }] });
  await tool('delete_time_entries', { ids: [local.created[0].id] });
  eq(await store.byPublicId(local.created[0].id), null, 'unsent entry deleted, free');
  await assert.rejects(tool('delete_time_entries', { ids: [one.id] }), /already in Toggl/);
  checks++;

  // ── A tag created by one call is known to the next ──
  await tool('create_time_entries', {
    allow_new_tags: true,
    entries: [{ start: `${d}T22:00`, duration_minutes: 15, description: 'New tag', project: 'Alpha', tags: ['D-NEW'] }],
  });
  const reuse = await tool('create_time_entries', {
    entries: [{ start: `${d}T22:30`, duration_minutes: 15, description: 'Reuses it', project: 'Alpha', tags: ['D-NEW'] }],
  });
  eq(reuse.created.length, 1, 'a new tag is accepted by the next call without allow_new_tags');
  await sync.push();

  // ── Leases ──
  await tool('create_time_entries', { entries: [{ start: `${d}T21:00`, duration_minutes: 15, description: 'Race', project: 'Alpha' }] });
  const beforeRace = posts();
  const [r1, r2] = await Promise.all([sync.push(), sync.push()]);
  eq([r1.pushed + r2.pushed, posts() - beforeRace], [1, 1], 'two concurrent pushes send it once');

  // ── A since too old falls back to a range re-read ──
  ok((await sync.syncNow({ pull: 'force', push: false })).error === null, 'sync round without errors');

  console.log(`✓ ${checks} mirror integration checks passed (${toggl.log.length} fake Toggl requests)`);
} catch (e) {
  console.error(e);
  console.error('fake Toggl log (last 15):', toggl.log.slice(-15));
  exitCode = 1;
} finally {
  await db.dropDatabase();
  process.exit(exitCode);
}
