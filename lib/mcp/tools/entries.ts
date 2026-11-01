// Time entries, on the local copy of Toggl (lib/mirror). Writes land in the
// mirror at once and reach Toggl in the background as its hourly quota
// allows, so a batch never waits for the quota and the dashboard and
// timesheet show it immediately. Each entry reports its sync status.

import { z } from 'zod';
import { QUOTA_RESERVE, getAccount, rememberTags, remainingIn, type TogglAccount } from '@/lib/toggl/server';
import {
  EMPTY_PUSH,
  changedGroups,
  publicId,
  spanOf,
  statusOf,
  toTimeEntry,
  type EntryFields,
  type MirrorDoc,
} from '@/lib/mirror/model';
import { byPublicId, docFromLocal, entriesCol, getState, nextLocalSeq, queueStatus } from '@/lib/mirror/store';
import { readMirror } from '@/lib/mirror/read';
import { push, pullIntervalSec, syncAfterResponse } from '@/lib/mirror/sync';
import {
  compactEntry,
  coveringWindow,
  planEntries,
  resolveProject,
  resolveTags,
  resolveTimes,
  totals,
  type EntryInput,
} from '../entries';
import { dateRange, fmtLocal, hours } from '../time';
import { ToolError, audit, defineTool, type ToolContext } from '../tool-kit';

const MAX_BATCH = 200;
/** Entries Toggl takes per hour after the dashboard's reserve, for the estimate. */
const WRITES_PER_HOUR = 30 - QUOTA_RESERVE;

const localTime = z
  .string()
  .describe('Local wall time "YYYY-MM-DDTHH:MM" (in the app time zone, see get_context) or ISO 8601 with an offset.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/** An entry for the agent: the compact shape plus where it stands with Toggl. */
function describe(doc: MirrorDoc, account: TogglAccount, nowMs: number) {
  const status = statusOf(doc);
  return {
    ...compactEntry(toTimeEntry(doc), account, nowMs),
    sync: status,
    ...(doc.toggl_id === null ? { in_toggl: false } : {}),
    ...(status === 'failed' ? { error: doc.push.last_error } : {}),
    ...(doc.remote_deleted ? { conflict: 'deleted in Toggl while edited here' } : {}),
    ...(doc.conflicts.length ? { conflicts: doc.conflicts } : {}),
  };
}

/** The queue in one line for results: how many wait and roughly how long. */
async function queueSummary() {
  const [q, quota, st] = await Promise.all([queueStatus(), remainingIn('workspace'), getState()]);
  const hoursLeft = Math.ceil(q.pending / WRITES_PER_HOUR);
  return {
    waiting_for_toggl: q.pending,
    failed: q.failed,
    conflicts: q.conflicts,
    estimate:
      q.pending === 0
        ? 'nothing waiting'
        : q.pending <= Math.max(0, (quota?.remaining ?? WRITES_PER_HOUR) - QUOTA_RESERVE)
        ? 'within minutes'
        : `about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'} (≈${WRITES_PER_HOUR} per hour)`,
    last_push: st?.last_push_at ? fmtLocal(st.last_push_at.getTime()) : null,
  };
}

function rangeOrThrow(from: string, to: string) {
  try {
    return dateRange(from, to);
  } catch (e) {
    throw new ToolError((e as Error).message);
  }
}

// ─── list_time_entries ──────────────────────────────────────────────────────

const listTimeEntries = defineTool({
  name: 'list_time_entries',
  title: 'List time entries',
  description:
    'Time entries between two local dates (inclusive), with hours per day and per Saturday–Friday week, from the local copy of Toggl. ' +
    `It is refreshed from Toggl at most every ${Math.round(pullIntervalSec() / 60)} minutes in one request; fresh: true refreshes now. ` +
    'Each entry has sync: "synced" (in Toggl), "pending" (waiting to be sent; negative ids are not in Toggl yet), "failed" or "conflict". ' +
    'Weeks not read before are loaded from Toggl once (only about the last three months are available).',
  access: 'read',
  input: {
    from: date,
    to: date,
    projects: z
      .array(z.union([z.string(), z.number().int()]))
      .optional()
      .describe('Only these projects (names or ids). Default: all.'),
    fresh: z.boolean().optional(),
  },
  handler: async ({ from, to, projects, fresh }) => {
    const range = rangeOrThrow(from, to);
    const { value: account } = await getAccount();
    // Archived projects are fine to read.
    const ids = projects?.map((p) => {
      const r = resolveProject({ ...account, projects: account.projects.map((x) => ({ ...x, active: true })) }, p);
      if (!r.ok) throw new ToolError(r.error);
      return r.value.id;
    });
    const read = await readMirror(range.fromMs, range.toMs, { fresh });
    const now = Date.now();
    const docs = read.docs.filter(
      (d) => !ids || (d.fields.project_id !== null && ids.includes(d.fields.project_id))
    );
    return {
      toggl_read_at: read.dataAtMs ? fmtLocal(read.dataAtMs) : null,
      ...(read.warning ? { warning: read.warning } : {}),
      count: docs.length,
      ...totals(docs.map(toTimeEntry), now),
      entries: docs.map((d) => describe(d, account, now)),
      queue: await queueSummary(),
    };
  },
});

// ─── create_time_entries ────────────────────────────────────────────────────

const entryInput = z.object({
  start: localTime,
  stop: localTime.optional().describe('End time. Give this or duration_minutes.'),
  duration_minutes: z.number().positive().optional(),
  description: z.string().max(3000),
  project: z.union([z.string(), z.number().int()]).describe('Project name or id (see get_context).'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Tag names. A billing code alone finds its tag ("D-123" → "D-123 Phase 2").'),
  billable: z.boolean().optional(),
});

const createTimeEntries = defineTool({
  name: 'create_time_entries',
  title: 'Create time entries',
  description:
    `Create up to ${MAX_BATCH} entries. They are saved at once (the dashboard, timesheet and get_timesheet show them immediately) ` +
    `and sent to Toggl in the background, about ${WRITES_PER_HOUR} per hour within its quota; the result says how long that takes. ` +
    'The whole batch is validated first (times, projects, tags); nothing is saved if any item fails. Entries that already exist ' +
    '(same start minute, project and description) are skipped, so re-sending a batch is safe. Overlaps are reported, not blocked. ' +
    'Until an entry reaches Toggl its id is negative; use it as is with the other tools.',
  access: 'write',
  input: {
    entries: z.array(entryInput).min(1).max(MAX_BATCH),
    allow_new_tags: z
      .boolean()
      .optional()
      .describe('Create tags that do not exist yet. Default false: an unknown tag fails the batch (usually a typo).'),
    avoid_projects: z
      .array(z.union([z.string(), z.number().int()]))
      .optional()
      .describe(
        'Projects whose existing entries the new ones must not overlap (e.g. travel and lunch): each new entry is trimmed ' +
          'to the gap, and one left shorter than a minute is skipped. The result lists what was trimmed.'
      ),
    dry_run: z.boolean().optional().describe('Validate and report the plan without saving.'),
  },
  handler: async ({ entries, allow_new_tags, avoid_projects, dry_run }, ctx) => {
    const { value: account } = await getAccount();
    const now = Date.now();
    const avoidProjectIds = (avoid_projects ?? []).map((p) => {
      const r = resolveProject({ ...account, projects: account.projects.map((x) => ({ ...x, active: true })) }, p);
      if (!r.ok) throw new ToolError(r.error);
      return r.value.id;
    });
    const opts = { allowNewTags: !!allow_new_tags, nowMs: now, avoidProjectIds };
    const first = planEntries(entries as EntryInput[], account, [], opts);
    if (first.errors.length) throw new ToolError(`Nothing was saved.\n${first.errors.join('\n')}`);
    const win = coveringWindow(first.planned);
    if (!win) throw new ToolError('Nothing to create.');
    const read = await readMirror(Date.parse(win.startISO), Date.parse(win.endISO));
    const { planned, trimmed, skippedInside } = planEntries(
      entries as EntryInput[],
      account,
      read.docs.map(toTimeEntry),
      opts
    );

    const todo = planned.filter((p) => p.duplicateOf === null && p.repeatOf === null);
    const skipped = planned
      .filter((p) => p.duplicateOf !== null || p.repeatOf !== null)
      .map((p) =>
        p.duplicateOf !== null
          ? { index: p.index, existing_id: p.duplicateOf, entry: p.summary }
          : { index: p.index, same_as_index: p.repeatOf, entry: p.summary }
      );
    const overlaps = planned.filter((p) => p.overlaps.length).map((p) => ({ index: p.index, overlaps: p.overlaps }));
    const newTags = [...new Set(planned.flatMap((p) => p.newTags))];

    if (dry_run) {
      return {
        dry_run: true,
        would_create: todo.map((p) => ({ index: p.index, entry: p.summary, hours: hours(p.write.duration) })),
        skipped_duplicates: skipped,
        trimmed_around_avoided: trimmed,
        skipped_inside_avoided: skippedInside,
        overlaps,
        new_tags: newTags,
        queue: await queueSummary(),
      };
    }

    const col = await entriesCol();
    const created: { index: number; id: number; entry: string }[] = [];
    for (const p of todo) {
      const doc = await docFromLocal(account.workspaceId, p.write);
      await col.insertOne(doc);
      created.push({ index: p.index, id: publicId(doc), entry: p.summary });
      await audit(ctx, {
        tool: 'create_time_entries',
        action: 'create',
        entryId: publicId(doc),
        after: compactEntry(toTimeEntry(doc), account, now),
      });
    }
    if (created.length) {
      await rememberTags(newTags);
      await syncAfterResponse({ pull: 'none' });
    }
    return {
      created,
      skipped_duplicates: skipped,
      trimmed_around_avoided: trimmed,
      skipped_inside_avoided: skippedInside,
      overlaps,
      new_tags: newTags,
      queue: await queueSummary(),
    };
  },
});

// ─── update_time_entries ────────────────────────────────────────────────────

const updateInput = z.object({
  id: z.number().int().describe('From list_time_entries; negative for entries not yet in Toggl.'),
  start: localTime.optional(),
  stop: localTime.optional(),
  duration_minutes: z.number().positive().optional().describe('New length, keeping the (new) start.'),
  description: z.string().max(3000).optional(),
  project: z.union([z.string(), z.number().int()]).optional(),
  tags: z.array(z.string()).optional().describe('Replace all tags.'),
  add_tags: z.array(z.string()).optional(),
  remove_tags: z.array(z.string()).optional(),
  billable: z.boolean().optional(),
});

type UpdateInput = z.infer<typeof updateInput>;

/** The entry's fields after the update. */
export function applyUpdate(u: UpdateInput, before: EntryFields, account: TogglAccount, allowNewTags: boolean): EntryFields {
  if (!before.stop) throw new ToolError(`Entry ${u.id} is running; stop it in Toggl first.`);
  const next: EntryFields = { ...before, tags: [...before.tags] };
  const beforeStart = Date.parse(before.start);
  const beforeStop = Date.parse(before.stop);

  if (u.start !== undefined || u.stop !== undefined || u.duration_minutes !== undefined) {
    if (u.stop !== undefined && u.duration_minutes !== undefined) {
      throw new ToolError(`Entry ${u.id}: give stop or duration_minutes, not both.`);
    }
    const keepLength = u.stop === undefined && u.duration_minutes === undefined;
    // The stored instant itself when start is not being changed: re-reading it
    // as local wall time would drop its seconds and, in the repeated autumn
    // hour, could move it by an hour.
    const times = resolveTimes(
      u.start ?? before.start,
      keepLength ? undefined : u.stop,
      keepLength ? (beforeStop - beforeStart) / 60000 : u.duration_minutes
    );
    if (!times.ok) throw new ToolError(`Entry ${u.id}: ${times.error}`);
    next.start = new Date(times.value.startMs).toISOString();
    next.stop = new Date(times.value.stopMs).toISOString();
    next.duration = Math.round((times.value.stopMs - times.value.startMs) / 1000);
  }
  if (u.description !== undefined) next.description = u.description.trim();
  if (u.project !== undefined) {
    const r = resolveProject(account, u.project);
    if (!r.ok) throw new ToolError(`Entry ${u.id}: ${r.error}`);
    next.project_id = r.value.id;
  }
  if (u.tags !== undefined || u.add_tags !== undefined || u.remove_tags !== undefined) {
    // Tags the entry already carries stay as they are, even ones the catalog
    // doesn't know yet (created by an earlier allow_new_tags write).
    const kept = u.tags !== undefined ? [] : before.tags;
    const resolved = resolveTags(account, [...(u.tags ?? []), ...(u.add_tags ?? [])], allowNewTags);
    if (resolved.errors.length) throw new ToolError(`Entry ${u.id}: ${resolved.errors.join(' ')}`);
    const removed = new Set(
      (u.remove_tags ?? []).flatMap((t) => [t.trim(), ...resolveTags(account, [t], true).tags])
    );
    next.tags = [...new Set([...kept, ...resolved.tags])].filter((t) => !removed.has(t));
  }
  if (u.billable !== undefined) next.billable = u.billable;
  return next;
}

const updateTimeEntries = defineTool({
  name: 'update_time_entries',
  title: 'Update time entries',
  description:
    `Change up to ${MAX_BATCH} entries (ids from list_time_entries, negative ones included): time, description, project, tags. ` +
    'Fields not given stay as they are; changing start alone moves the entry and keeps its length. Saved at once and sent to Toggl ' +
    'in the background; several edits to one entry before it is sent cost a single Toggl request. If the same field was also changed ' +
    'in Toggl meanwhile, this edit wins and the entry shows a conflict (see resolve_conflicts).',
  access: 'write',
  input: {
    updates: z.array(updateInput).min(1).max(MAX_BATCH),
    allow_new_tags: z.boolean().optional(),
    dry_run: z.boolean().optional(),
  },
  handler: async ({ updates, allow_new_tags, dry_run }, ctx: ToolContext) => {
    const { value: account } = await getAccount();
    const now = Date.now();
    const plans = [];
    for (const u of updates as UpdateInput[]) {
      const doc = await byPublicId(u.id);
      if (!doc) throw new ToolError(`Entry ${u.id} is not in the local copy. List its week first (list_time_entries).`);
      const next = applyUpdate(u, doc.fields, account, !!allow_new_tags);
      plans.push({ u, doc, next, changed: changedGroups(doc.fields, next) });
    }
    const changing = plans.filter((p) => p.changed.length > 0);
    const unchanged = plans.filter((p) => p.changed.length === 0).map((p) => p.u.id);
    const show = (f: EntryFields, doc: MirrorDoc) => compactEntry(toTimeEntry({ ...doc, fields: f }), account, now);

    if (dry_run) {
      return {
        dry_run: true,
        would_update: changing.map((p) => ({ id: p.u.id, changes: p.changed, before: show(p.doc.fields, p.doc), after: show(p.next, p.doc) })),
        unchanged,
        queue: await queueSummary(),
      };
    }

    const col = await entriesCol();
    const updated: { id: number; changes: string[] }[] = [];
    for (const p of changing) {
      // Saved against the version it was read at. If a pull or a push changed
      // the entry meanwhile, re-read it and apply the same update to its
      // current state, so nothing merged in between is written back over.
      let doc = p.doc;
      let next = p.next;
      for (let attempt = 0; ; attempt++) {
        const dirty = doc.remote ? changedGroups(next, doc.remote).length > 0 : true;
        const res = await col.updateOne(
          { _id: doc._id, version: doc.version },
          {
            $set: {
              fields: next,
              ...spanOf(next),
              dirty,
              // An edit is a new attempt: a parked entry gets another try. A
              // create already sent keeps its in-flight marker for adoption.
              push: { ...EMPTY_PUSH, in_flight_since: doc.push.in_flight_since, sent: doc.push.sent ?? null },
              updated_at: new Date(),
            },
            $inc: { version: 1 },
          }
        );
        if (res.matchedCount > 0) break;
        const fresh = await col.findOne({ _id: doc._id });
        if (!fresh || attempt >= 3) throw new ToolError(`Entry ${p.u.id} kept changing while saving; list it and try again.`);
        doc = fresh;
        next = applyUpdate(p.u, fresh.fields, account, !!allow_new_tags);
      }
      p.next = next;
      updated.push({ id: p.u.id, changes: p.changed });
      await audit(ctx, {
        tool: 'update_time_entries',
        action: 'update',
        entryId: p.u.id,
        before: show(doc.fields, doc),
        after: show(next, doc),
      });
    }
    if (updated.length) {
      const known = new Set(account.tags.map((t) => t.name));
      await rememberTags(changing.flatMap((p) => p.next.tags).filter((t) => !known.has(t)));
      await syncAfterResponse({ pull: 'none' });
    }
    return { updated, unchanged, queue: await queueSummary() };
  },
});

// ─── delete_time_entries ────────────────────────────────────────────────────

const deleteTimeEntries = defineTool({
  name: 'delete_time_entries',
  title: 'Delete entries not yet in Toggl',
  description:
    'Discard entries created here that have not reached Toggl yet (negative ids). Costs no Toggl request. ' +
    'Entries already in Toggl are refused: deleting those is left to the user, in Toggl.',
  access: 'write',
  input: {
    ids: z.array(z.number().int()).min(1).max(MAX_BATCH),
    dry_run: z.boolean().optional(),
  },
  handler: async ({ ids, dry_run }, ctx: ToolContext) => {
    const { value: account } = await getAccount();
    const now = Date.now();
    const docs = [];
    for (const id of ids) {
      const doc = await byPublicId(id);
      if (!doc) throw new ToolError(`Entry ${id} is not in the local copy.`);
      if (doc.toggl_id !== null || doc.push.in_flight_since) {
        throw new ToolError(`Entry ${id} is already in Toggl (or being sent); delete it in Toggl. Nothing was deleted.`);
      }
      docs.push(doc);
    }
    if (dry_run) return { dry_run: true, would_delete: docs.map((d) => compactEntry(toTimeEntry(d), account, now)) };
    const col = await entriesCol();
    const refused: number[] = [];
    for (const d of docs) {
      // Only while the pusher hasn't claimed it (sync.ts pushOne).
      const res = await col.deleteOne({ _id: d._id, toggl_id: null, 'push.in_flight_since': null });
      if (res.deletedCount === 0) {
        refused.push(publicId(d));
        continue;
      }
      await audit(ctx, {
        tool: 'delete_time_entries',
        action: 'delete',
        entryId: publicId(d),
        before: compactEntry(toTimeEntry(d), account, now),
      });
    }
    return {
      deleted: docs.map(publicId).filter((id) => !refused.includes(id)),
      ...(refused.length
        ? { not_deleted: refused.map((id) => ({ id, reason: 'being sent to Toggl right now; it will be in Toggl shortly' })) }
        : {}),
      queue: await queueSummary(),
    };
  },
});

// ─── get_sync_status / resolve_conflicts ────────────────────────────────────

const getSyncStatus = defineTool({
  name: 'get_sync_status',
  title: 'Get sync status',
  description:
    'How the local copy stands with Toggl: entries waiting to be sent and the estimate, entries Toggl refused (with its error), ' +
    'conflicts, last pull and push, and the quota. push_now: true sends what the quota allows right away (up to ~40 s) instead of ' +
    'waiting for the background run.',
  access: 'read',
  input: { push_now: z.boolean().optional() },
  handler: async ({ push_now }) => {
    const { value: account } = await getAccount();
    const run = push_now ? await push() : null;
    const col = await entriesCol();
    const now = Date.now();
    const problems = await col
      .find({ $or: [{ 'push.failed': true }, { remote_deleted: true }, { 'conflicts.0': { $exists: true } }] })
      .sort({ start_at: 1 })
      .limit(50)
      .toArray();
    const st = await getState();
    const quota = await remainingIn('workspace');
    return {
      ...(run ? { pushed_now: run.pushed, stopped: run.stopped } : {}),
      queue: await queueSummary(),
      problems: problems.map((d) => describe(d, account, now)),
      last_pull: st?.last_pull_at ? fmtLocal(st.last_pull_at.getTime()) : null,
      last_error: st?.last_error ?? null,
      covered_from: st?.covered_from_ms ? fmtLocal(st.covered_from_ms).slice(0, 10) : null,
      write_quota: quota ? { remaining: quota.remaining, resets_in_minutes: Math.ceil(quota.resetsInSec / 60) } : null,
    };
  },
});

const resolveConflicts = defineTool({
  name: 'resolve_conflicts',
  title: 'Resolve conflicts',
  description:
    'Settle entries with sync "conflict" or "failed". keep "local" sends this copy to Toggl (for an entry deleted in Toggl: creates it again); ' +
    'keep "toggl" drops the local changes and takes what Toggl has (for an entry deleted in Toggl: deletes the local copy too).',
  access: 'write',
  input: {
    resolutions: z.array(z.object({ id: z.number().int(), keep: z.enum(['local', 'toggl']) })).min(1).max(MAX_BATCH),
  },
  handler: async ({ resolutions }, ctx: ToolContext) => {
    const col = await entriesCol();
    const done: { id: number; kept: string; new_id?: number }[] = [];
    for (const r of resolutions) {
      const doc = await byPublicId(r.id);
      if (!doc) throw new ToolError(`Entry ${r.id} is not in the local copy.`);
      if (r.keep === 'local') {
        // Re-created in Toggl: it needs a local number to be addressed by
        // until Toggl assigns a new id.
        const recreate = doc.remote_deleted;
        const localSeq = recreate && doc.local_seq === null ? await nextLocalSeq() : doc.local_seq;
        await col.updateOne(
          { _id: doc._id },
          {
            $set: {
              conflicts: [],
              // A create that may have reached Toggl keeps its in-flight
              // marker, so the next push checks Toggl before sending again.
              push: {
                ...EMPTY_PUSH,
                in_flight_since: recreate ? null : doc.push.in_flight_since,
                sent: recreate ? null : doc.push.sent ?? null,
              },
              dirty: true,
              local_seq: localSeq,
              ...(recreate ? { remote_deleted: false, toggl_id: null, remote: null } : {}),
              updated_at: new Date(),
            },
            $inc: { version: 1 },
          }
        );
      } else if (doc.remote_deleted || !doc.remote) {
        await col.deleteOne({ _id: doc._id });
      } else {
        const { at: _at, ...fields } = doc.remote;
        await col.updateOne(
          { _id: doc._id },
          {
            $set: { fields, ...spanOf(fields), conflicts: [], push: { ...EMPTY_PUSH }, dirty: false, updated_at: new Date() },
            $inc: { version: 1 },
          }
        );
      }
      const after = await col.findOne({ _id: doc._id });
      done.push({ id: r.id, kept: r.keep, ...(after && publicId(after) !== r.id ? { new_id: publicId(after) } : {}) });
      await audit(ctx, { tool: 'resolve_conflicts', action: 'update', entryId: r.id, before: { sync: statusOf(doc) }, after: { kept: r.keep } });
    }
    await syncAfterResponse({ pull: 'none' });
    return { resolved: done, queue: await queueSummary() };
  },
});

export const entryTools = [
  listTimeEntries,
  createTimeEntries,
  updateTimeEntries,
  deleteTimeEntries,
  getSyncStatus,
  resolveConflicts,
];
