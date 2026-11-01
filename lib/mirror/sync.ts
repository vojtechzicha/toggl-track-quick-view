// Keeping the mirror and Toggl in step (README → "Toggl rate limits").
//
// Pull: GET /me/time_entries?since=… returns every entry changed in Toggl
// since the last pull, deleted ones included, in one request. Each is merged
// into the mirror (mergeRemote). The first pull fills the mirror with the last
// FILL_WEEKS weeks; older weeks are filled on demand (ensureCovered).
//
// Push: entries changed here go to Toggl one request each, oldest first,
// while the hourly quota allows (QUOTA_RESERVE stays for the dashboard).
// A lease keeps it to one instance at a time.
//
// Nothing here schedules itself: routes call syncNow() (the dashboard read,
// the MCP tools after a write, /api/toggl-sync from a scheduled workflow).

import {
  CREATED_WITH,
  QUOTA_RESERVE,
  TogglError,
  getAccount,
  isQuotaError,
  remainingIn,
  togglRequestMeta,
  type ResponseQuota,
} from '@/lib/toggl/server';
import { cacheIntervalSec } from '@/lib/serverCache';
import { addDays, startOfWeek } from '@/lib/calc';
import {
  EMPTY_PUSH,
  MAX_PUSH_ATTEMPTS,
  changedGroups,
  createBody,
  fieldsFromToggl,
  matchesInFlight,
  mergeRemote,
  spanOf,
  updateBody,
  type MirrorDoc,
  type TogglEntry,
} from './model';
import {
  acquireLease,
  byTogglId,
  docFromRemote,
  entriesCol,
  getState,
  queueStatus,
  setState,
  type MirrorState,
} from './store';

/** How far back the first fill reaches. */
export const FILL_WEEKS = 13;
/** One range request per this many weeks (Toggl answers at most 1000 entries). */
const CHUNK_WEEKS = 4;
const DEFAULT_PULL_SEC = 180;
/** While entries wait for Toggl, pulls slow down so writes get the budget. */
const BACKLOG_PULL_SEC = 600;
/** Ask for changes a little before the last pull, in case clocks differ. */
const SINCE_OVERLAP_MS = 60_000;
/** A full re-read of the recent weeks once a day catches anything `since` missed. */
const RECONCILE_MS = 24 * 3600 * 1000;
let writeSpacingMs = 1000; // Toggl's per-IP safeguard tolerates about one request a second
let backgroundSync = true;

/** scripts/test-mirror.ts only: no spacing, and no sync started behind the test's back. */
export function configureForTests(opts: { writeSpacingMs?: number; backgroundSync?: boolean }): void {
  if (opts.writeSpacingMs !== undefined) writeSpacingMs = opts.writeSpacingMs;
  if (opts.backgroundSync !== undefined) backgroundSync = opts.backgroundSync;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The mirror is on when the server holds the Toggl token and has a database. */
export function mirrorEnabled(): boolean {
  return !!process.env.TOGGL_API_TOKEN && !!process.env.MONGODB_URI && !!process.env.APP_PASSWORD;
}

/** Seconds between pulls: the shared-cache interval the dashboard already uses. */
export function pullIntervalSec(): number {
  return cacheIntervalSec() ?? DEFAULT_PULL_SEC;
}

let defaultWorkspace: number | null = null;

async function workspaceId(): Promise<number> {
  if (defaultWorkspace !== null) return defaultWorkspace;
  defaultWorkspace = (await getAccount()).value.workspaceId;
  return defaultWorkspace;
}

// ─── Applying Toggl's state ─────────────────────────────────────────────────

export interface ApplyCounts {
  inserted: number;
  updated: number;
  deleted: number;
  adopted: number;
  conflicts: number;
}

const emptyCounts = (): ApplyCounts => ({ inserted: 0, updated: 0, deleted: 0, adopted: 0, conflicts: 0 });

/** Merge one entry Toggl reported into the mirror. */
export async function applyRemote(e: TogglEntry, counts: ApplyCounts = emptyCounts()): Promise<ApplyCounts> {
  const col = await entriesCol();
  for (let attempt = 0; attempt < 3; attempt++) {
    const doc = await byTogglId(e.id);

    if (e.server_deleted_at) {
      if (!doc) return counts;
      if (!doc.dirty) {
        await col.deleteOne({ _id: doc._id, version: doc.version });
        counts.deleted++;
      } else {
        // Edited here, deleted in Toggl: keep it and let the user decide.
        await col.updateOne(
          { _id: doc._id, version: doc.version },
          { $set: { remote_deleted: true, updated_at: new Date() } }
        );
        counts.conflicts++;
      }
      return counts;
    }

    if (!doc) {
      // Our own create, whose answer was lost? Adopt it rather than insert a twin.
      const inFlight = await col
        .find({ toggl_id: null, 'push.in_flight_since': { $ne: null } })
        .toArray();
      const mine = inFlight.find((d) => matchesInFlight(d, e));
      if (mine) {
        const theirs = fieldsFromToggl(e);
        const res = await col.updateOne(
          { _id: mine._id, version: mine.version },
          {
            $set: {
              toggl_id: e.id,
              remote: { ...theirs, at: e.at },
              // Edits made after the lost create (tags, say) still have to go out.
              dirty: changedGroups(mine.fields, theirs).length > 0,
              push: { ...EMPTY_PUSH },
              updated_at: new Date(),
            },
            $inc: { version: 1 },
          }
        );
        if (res.matchedCount === 0) continue;
        counts.adopted++;
        return counts;
      }
      try {
        await col.insertOne(docFromRemote(e.id, e.workspace_id, fieldsFromToggl(e), e.at));
        counts.inserted++;
      } catch (err) {
        if ((err as { code?: number }).code === 11000) continue; // inserted concurrently
        throw err;
      }
      return counts;
    }

    // Our own write echoed back, or nothing new.
    if (doc.remote?.at === e.at) return counts;

    const merged = mergeRemote(doc, e);
    const res = await col.updateOne(
      { _id: doc._id, version: doc.version },
      {
        $set: {
          fields: merged.fields,
          remote: merged.remote,
          dirty: merged.dirty,
          ...spanOf(merged.fields),
          updated_at: new Date(),
        },
        // Any change bumps the version, so a tool holding an older snapshot
        // re-reads instead of writing it back over this merge.
        $inc: { version: 1 },
        ...(merged.conflicts.length ? { $push: { conflicts: { $each: merged.conflicts } } } : {}),
      }
    );
    if (res.matchedCount === 0) continue; // edited meanwhile: merge again
    counts.updated++;
    counts.conflicts += merged.conflicts.length;
    return counts;
  }
  throw new Error(`Entry ${e.id} kept changing while it was merged.`);
}

// ─── Pull ───────────────────────────────────────────────────────────────────

async function getRange(fromMs: number, toMs: number): Promise<TogglEntry[]> {
  const q = `start_date=${encodeURIComponent(new Date(fromMs).toISOString())}&end_date=${encodeURIComponent(
    new Date(toMs).toISOString()
  )}`;
  return (await togglRequestMeta<TogglEntry[] | null>('GET', `/me/time_entries?${q}`)).data ?? [];
}

/**
 * Re-read [fromMs, toMs) from Toggl. Entries in the window that Toggl no
 * longer has, and that have no pending local edit, are removed.
 */
export async function refreshRange(fromMs: number, toMs: number): Promise<ApplyCounts> {
  const counts = emptyCounts();
  const col = await entriesCol();
  for (let a = fromMs; a < toMs; a = addDays(a, CHUNK_WEEKS * 7)) {
    const b = Math.min(toMs, addDays(a, CHUNK_WEEKS * 7));
    // Only documents unchanged since the request went out can be judged by
    // its answer: one a push acknowledged meanwhile is missing from it.
    const requestedAt = new Date();
    const remote = await getRange(a, b);
    for (const e of remote) await applyRemote(e, counts);
    const seen = new Set(remote.map((e) => e.id));
    const stale = await col
      .find({
        toggl_id: { $ne: null },
        start_at: { $gte: new Date(a), $lt: new Date(b) },
        dirty: false,
        updated_at: { $lt: requestedAt },
      })
      .toArray();
    for (const d of stale) {
      if (d.toggl_id !== null && !seen.has(d.toggl_id)) {
        await col.deleteOne({ _id: d._id, version: d.version, dirty: false });
        counts.deleted++;
      }
    }
  }
  return counts;
}

/** The fill reaches this far ahead (scheduled entries). Later weeks are read on demand. */
const FILL_AHEAD_DAYS = 8;

async function fill(now: number): Promise<MirrorState> {
  const from = addDays(startOfWeek(new Date(now)).getTime(), -7 * (FILL_WEEKS - 1));
  const to = addDays(now, FILL_AHEAD_DAYS);
  await refreshRange(from, to);
  await setState({
    covered_from_ms: from,
    covered_to_ms: to,
    since_ms: now,
    last_pull_at: new Date(now),
    last_reconcile_at: new Date(now),
    last_error: null,
  });
  return (await getState())!;
}

/** Fill the mirror on first use. One request per CHUNK_WEEKS weeks. */
export async function ensureFilled(): Promise<MirrorState> {
  const st = await getState();
  if (st?.covered_from_ms) return st;
  const release = await acquireLease('pull', 120_000);
  if (!release) {
    // Another instance is filling; wait for it.
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const s = await getState();
      if (s?.covered_from_ms) return s;
    }
    throw new Error('The mirror is still being filled. Try again in a minute.');
  }
  try {
    return await fill(Date.now());
  } finally {
    await release();
  }
}

/** Make sure entries from `fromMs` on are in the mirror; reads older weeks from Toggl once. */
export async function ensureCovered(fromMs: number, toMs?: number): Promise<void> {
  const st = await ensureFilled();
  if (fromMs < st.covered_from_ms) {
    const from = startOfWeek(new Date(fromMs)).getTime();
    await refreshRange(from, st.covered_from_ms);
    await setState({ covered_from_ms: from });
  }
  // Entries already scheduled beyond the fill never change, so no pull brings
  // them: read later weeks once, as they are asked for.
  const coveredTo = st.covered_to_ms ?? addDays(st.since_ms, FILL_AHEAD_DAYS);
  if (toMs !== undefined && toMs > coveredTo) {
    await refreshRange(coveredTo, toMs);
    await setState({ covered_to_ms: toMs });
  }
}

/**
 * One incremental pull, if the last one is older than `maxAgeSec` (0 =
 * always) and no other instance is pulling. Returns whether it ran.
 */
export async function pullIfStale(maxAgeSec: number): Promise<boolean> {
  const st = await ensureFilled();
  const now = Date.now();
  if (st.last_pull_at && now - st.last_pull_at.getTime() < maxAgeSec * 1000) return false;
  const release = await acquireLease('pull', 60_000);
  if (!release) return false;
  try {
    const sinceSec = Math.floor((st.since_ms - SINCE_OVERLAP_MS) / 1000);
    let changed: TogglEntry[];
    try {
      changed = (await togglRequestMeta<TogglEntry[] | null>('GET', `/me/time_entries?since=${sinceSec}`)).data ?? [];
    } catch (e) {
      // A `since` too far back is refused; re-read the recent weeks instead.
      if (e instanceof TogglError && e.status === 400) {
        // Changes since the bookmark are unknown everywhere. Re-read the recent
        // weeks now and narrow the coverage to them, so any older or later week
        // is read again (ensureCovered) before it is served.
        const from = addDays(startOfWeek(new Date(now)).getTime(), -14);
        const to = addDays(now, FILL_AHEAD_DAYS);
        await refreshRange(from, to);
        await setState({
          covered_from_ms: from,
          covered_to_ms: to,
          since_ms: now,
          last_pull_at: new Date(now),
          last_reconcile_at: new Date(now),
        });
        return true;
      }
      throw e;
    }
    for (const e of changed) await applyRemote(e);
    await setState({ since_ms: now, last_pull_at: new Date(now), last_error: null });
    return true;
  } catch (e) {
    await setState({ last_error: (e as Error).message });
    throw e;
  } finally {
    await release();
  }
}

/** Re-read the current and previous week once a day (one or two requests). */
async function reconcileIfDue(): Promise<boolean> {
  const st = await ensureFilled();
  const now = Date.now();
  if (st.last_reconcile_at && now - st.last_reconcile_at.getTime() < RECONCILE_MS) return false;
  const release = await acquireLease('pull', 60_000);
  if (!release) return false;
  try {
    await refreshRange(addDays(startOfWeek(new Date(now)).getTime(), -7), addDays(now, 8));
    await setState({ last_reconcile_at: new Date(now) });
    return true;
  } finally {
    await release();
  }
}

// ─── Push ───────────────────────────────────────────────────────────────────

export interface PushResult {
  pushed: number;
  failed: number;
  /** Why the run stopped with work left, or null when the queue is empty. */
  stopped: string | null;
  quota: ResponseQuota | null;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Send queued changes to Toggl, oldest first, until the queue is empty, the
 * quota is down to QUOTA_RESERVE, or `budgetMs` has passed.
 */
export async function push(budgetMs = 40_000): Promise<PushResult> {
  const result: PushResult = { pushed: 0, failed: 0, stopped: null, quota: null };
  const release = await acquireLease('push', budgetMs + 15_000);
  if (!release) return { ...result, stopped: 'another instance is pushing' };
  const col = await entriesCol();
  const started = Date.now();
  let quota: ResponseQuota | null = await remainingIn('workspace');
  let sent = 0;
  try {
    for (;;) {
      const doc = await col
        .find({ dirty: true, 'push.failed': false, remote_deleted: false })
        .sort({ updated_at: 1 })
        .limit(1)
        .next();
      if (!doc) break;
      if (quota && quota.remaining <= QUOTA_RESERVE) {
        result.stopped = `quota: ${quota.remaining} requests left, kept for the dashboard; resets in ${Math.ceil(
          quota.resetsInSec / 60
        )} min`;
        break;
      }
      if (Date.now() - started > budgetMs) {
        result.stopped = 'time: the rest goes in the next run';
        break;
      }
      if (sent > 0) await sleep(writeSpacingMs);
      sent++;
      const outcome = await pushOne(doc);
      if (outcome.quota) quota = outcome.quota;
      if (outcome.kind === 'ok') result.pushed++;
      else if (outcome.kind === 'failed') result.failed++;
      else if (outcome.kind === 'stop') {
        result.stopped = outcome.reason;
        break;
      }
    }
    await setState({ last_push_at: new Date() });
  } finally {
    await release();
  }
  result.quota = quota;
  return result;
}

type Outcome =
  | { kind: 'ok'; quota: ResponseQuota | null }
  | { kind: 'failed'; quota: ResponseQuota | null }
  | { kind: 'stop'; reason: string; quota: ResponseQuota | null };

async function pushOne(read: MirrorDoc): Promise<Outcome> {
  let doc = read;
  const col = await entriesCol();
  const now = new Date();
  const creating = doc.toggl_id === null;

  // A create whose answer never arrived may have reached Toggl: pull first,
  // which adopts it if it did (applyRemote).
  // Only a pull that actually read Toggl may clear it for a second POST: if
  // another instance holds the pull lease, or Toggl can't be read, wait.
  if (creating && doc.push.in_flight_since) {
    const pulled = await pullIfStale(0).catch(() => false);
    if (!pulled) {
      return { kind: 'stop', reason: 'a create whose answer was lost waits for a pull to check Toggl', quota: null };
    }
    const again = await col.findOne({ _id: doc._id });
    if (!again || again.toggl_id !== null || !again.dirty) return { kind: 'ok', quota: null };
    doc = again;
  }

  // Claim the document as it was read: if it was deleted or edited since, the
  // claim misses and the next loop iteration picks up the current state. For a
  // create the claim records what is sent, so a lost answer can be adopted
  // (applyRemote) even if the entry is edited before the next pull, and
  // delete_time_entries refuses a claimed entry.
  const claim = await col.updateOne(
    { _id: doc._id, version: doc.version, toggl_id: doc.toggl_id },
    {
      $set: {
        'push.last_attempt_at': now,
        ...(creating
          ? {
              'push.in_flight_since': now,
              'push.sent': {
                start: doc.fields.start,
                project_id: doc.fields.project_id,
                description: doc.fields.description,
              },
            }
          : {}),
      },
    }
  );
  if (claim.matchedCount === 0) return { kind: 'ok', quota: null };

  try {
    let res: { data: TogglEntry; quota: ResponseQuota | null };
    if (creating) {
      const wid = doc.workspace_id || (await workspaceId());
      res = await togglRequestMeta<TogglEntry>('POST', `/workspaces/${wid}/time_entries`, createBody(doc, CREATED_WITH));
    } else {
      res = await togglRequestMeta<TogglEntry>(
        'PUT',
        `/workspaces/${doc.workspace_id}/time_entries/${doc.toggl_id}`,
        updateBody(doc)
      );
    }
    await acknowledge(doc, res.data);
    return { kind: 'ok', quota: res.quota };
  } catch (e) {
    if (isQuotaError(e)) {
      // 402/429: Toggl did not take it.
      await col.updateOne({ _id: doc._id }, { $set: { 'push.in_flight_since': null, 'push.sent': null } });
      return {
        kind: 'stop',
        reason: `quota: Toggl refused (HTTP ${e.status}); resets in ${Math.ceil((e.resetsInSec ?? 3600) / 60)} min`,
        quota: { remaining: 0, resetsInSec: e.resetsInSec ?? 3600 },
      };
    }
    if (e instanceof TogglError && e.status === 404 && !creating) {
      // Deleted in Toggl since the last pull.
      await col.updateOne({ _id: doc._id }, { $set: { remote_deleted: true, updated_at: new Date() } });
      return { kind: 'failed', quota: null };
    }
    // A 4xx is Toggl refusing this entry (an archived project, a bad value):
    // sending it again would only spend quota, so it is parked until edited.
    // Anything else (5xx, network) may have reached Toggl or may pass next
    // time; it is retried in later runs, MAX_PUSH_ATTEMPTS times.
    const refused = e instanceof TogglError && e.status >= 400 && e.status < 500;
    const attempts = doc.push.attempts + 1;
    const failed = refused || attempts >= MAX_PUSH_ATTEMPTS;
    await col.updateOne(
      { _id: doc._id },
      {
        $set: {
          'push.attempts': attempts,
          'push.last_error': errorText(e),
          // A create that may have reached Toggl stays in flight, so the next
          // try pulls first and adopts it instead of creating a twin.
          'push.in_flight_since': creating && !refused ? doc.push.in_flight_since ?? now : null,
          ...(creating && refused ? { 'push.sent': null } : {}),
          'push.failed': failed,
        },
      }
    );
    if (!refused) return { kind: 'stop', reason: `Toggl unreachable: ${errorText(e)}`, quota: null };
    return { kind: 'failed', quota: null };
  }
}

/**
 * Store Toggl's answer to a push. Unedited since it was read: the document
 * becomes Toggl's state, clean. Edited meanwhile: the edit stays, and `dirty`
 * is recomputed against what Toggl now has (an edit back to the old value is
 * then still a change to send).
 */
async function acknowledge(sentDoc: MirrorDoc, answer: TogglEntry): Promise<void> {
  const col = await entriesCol();
  const theirs = fieldsFromToggl(answer);
  const base = {
    toggl_id: answer.id,
    remote: { ...theirs, at: answer.at },
    push: { ...EMPTY_PUSH },
    updated_at: new Date(),
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = attempt === 0 ? sentDoc : await col.findOne({ _id: sentDoc._id });
    if (!current) return;
    const unchanged = current.version === sentDoc.version;
    const res = await col.updateOne(
      { _id: sentDoc._id, version: current.version },
      unchanged
        ? { $set: { ...base, dirty: false, fields: theirs, ...spanOf(theirs) }, $inc: { version: 1 } }
        : { $set: { ...base, dirty: changedGroups(current.fields, theirs).length > 0 }, $inc: { version: 1 } }
    );
    if (res.matchedCount > 0) return;
  }
  throw new Error(`Entry ${answer.id} kept changing while its push was stored.`);
}

// ─── Orchestration ──────────────────────────────────────────────────────────

export interface SyncRun {
  pulled: boolean;
  reconciled: boolean;
  push: PushResult | null;
  error: string | null;
}

/**
 * One round: pull if stale (slower while a backlog waits), the daily
 * re-read, then push. Errors are reported, not thrown, so a scheduled run
 * never fails noisily on a Toggl hiccup.
 */
export async function syncNow(opts: { pull?: 'stale' | 'force' | 'none'; push?: boolean; budgetMs?: number } = {}): Promise<SyncRun> {
  const run: SyncRun = { pulled: false, reconciled: false, push: null, error: null };
  try {
    await ensureFilled();
    const q = await queueStatus();
    if (opts.pull !== 'none') {
      const age = opts.pull === 'force' ? 0 : q.pending > 0 ? Math.max(BACKLOG_PULL_SEC, pullIntervalSec()) : pullIntervalSec();
      run.pulled = await pullIfStale(age);
    }
    run.reconciled = await reconcileIfDue();
    if (opts.push !== false && q.pending > 0) run.push = await push(opts.budgetMs);
  } catch (e) {
    run.error = errorText(e);
  }
  return run;
}

/**
 * Run a sync after the response is sent (Next's `after`), or right away
 * outside a request (scripts).
 */
export async function syncAfterResponse(opts?: Parameters<typeof syncNow>[0]): Promise<void> {
  if (!backgroundSync) return;
  try {
    const { after } = await import('next/server');
    after(() => syncNow(opts).then(() => undefined));
  } catch {
    void syncNow(opts);
  }
}
