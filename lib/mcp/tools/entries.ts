// Time entries: read, create, update. Writes go straight to Toggl and spend
// its hourly quota (30 requests/hour on Free, shared with the dashboard), so
// they stop while QUOTA_RESERVE requests are left and report what is still to
// do. Re-sending the same batch later is safe: entries already in Toggl (same
// start minute, project and description) are skipped.

import { z } from 'zod';
import type { TimeEntry } from '@/lib/calc';
import {
  QUOTA_RESERVE,
  createEntry,
  getAccount,
  getEntries,
  getEntry,
  invalidateEntries,
  isQuotaError,
  remainingIn,
  updateEntry,
  type EntryWrite,
  type ResponseQuota,
  type TogglAccount,
} from '@/lib/toggl/server';
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

const MAX_BATCH = 50;
// Stop starting writes after this long, so the function never hits its 60s limit.
const WRITE_DEADLINE_MS = 40_000;
// Toggl's per-IP safeguard tolerates about one request a second.
const WRITE_SPACING_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const localTime = z
  .string()
  .describe('Local wall time "YYYY-MM-DDTHH:MM" (in the app time zone, see get_context) or ISO 8601 with an offset.');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

function quotaNote(q: ResponseQuota | { remaining: number; resetsInSec: number } | null) {
  return q ? { remaining: q.remaining, resets_in_minutes: Math.ceil(q.resetsInSec / 60) } : null;
}

/** Entries of the week(s) around a batch, to dedupe and spot overlaps. One request at most. */
async function existingAround(planned: { write: EntryWrite }[]): Promise<TimeEntry[]> {
  const win = coveringWindow(planned);
  if (!win) return [];
  return (await getEntries(win.startISO, win.endISO)).value;
}

// ─── list_time_entries ──────────────────────────────────────────────────────

const listTimeEntries = defineTool({
  name: 'list_time_entries',
  title: 'List time entries',
  description:
    'Toggl time entries between two local dates (inclusive), with hours per day and per Saturday–Friday week. ' +
    'One Toggl request per range, cached for 2 minutes; pass fresh: true to bypass the cache. ' +
    'Toggl returns at most 1000 entries per range and only about the last three months.',
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
    let range;
    try {
      range = dateRange(from, to);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    const { value: account } = await getAccount();
    // Archived projects are fine to read.
    const ids = projects?.map((p) => {
      const r = resolveProject({ ...account, projects: account.projects.map((x) => ({ ...x, active: true })) }, p);
      if (!r.ok) throw new ToolError(r.error);
      return r.value.id;
    });
    const res = await getEntries(
      new Date(range.fromMs).toISOString(),
      new Date(range.toMs).toISOString(),
      fresh ? 0 : undefined
    );
    const now = Date.now();
    const entries = res.value
      .filter((e) => e.duration !== 0)
      .filter((e) => !ids || (e.project_id !== null && ids.includes(e.project_id)))
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return {
      data_at: fmtLocal(res.atMs),
      from_cache: res.cached,
      count: entries.length,
      ...totals(entries, now),
      entries: entries.map((e) => compactEntry(e, account, now)),
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
    `Create up to ${MAX_BATCH} entries in Toggl, one request each. The whole batch is validated first (times, projects, tags); ` +
    'nothing is written if any item fails. Entries already in Toggl (same start minute, project and description) are skipped, ' +
    `so re-sending a batch is safe. Writing stops when Toggl's quota is down to ${QUOTA_RESERVE} requests (kept for the dashboard) ` +
    'and the result lists what was not created and when the quota resets; send those again then. ' +
    'Overlaps with existing entries are reported, not blocked. Use dry_run first for larger batches.',
  access: 'write',
  input: {
    entries: z.array(entryInput).min(1).max(MAX_BATCH),
    allow_new_tags: z
      .boolean()
      .optional()
      .describe('Create tags that do not exist yet. Default false: an unknown tag fails the batch (usually a typo).'),
    dry_run: z.boolean().optional().describe('Validate and report the plan without writing.'),
  },
  handler: async ({ entries, allow_new_tags, dry_run }, ctx) => {
    const { value: account } = await getAccount();
    const now = Date.now();
    // Plan once without existing entries to get the window, then for real.
    const first = planEntries(entries as EntryInput[], account, [], { allowNewTags: !!allow_new_tags, nowMs: now });
    if (first.errors.length) throw new ToolError(`Nothing was created.\n${first.errors.join('\n')}`);
    const existing = await existingAround(first.planned);
    const { planned } = planEntries(entries as EntryInput[], account, existing, {
      allowNewTags: !!allow_new_tags,
      nowMs: now,
    });

    const todo = planned.filter((p) => p.duplicateOf === null);
    const skipped = planned
      .filter((p) => p.duplicateOf !== null)
      .map((p) => ({ index: p.index, existing_id: p.duplicateOf, entry: p.summary }));
    const overlaps = planned
      .filter((p) => p.overlaps.length)
      .map((p) => ({ index: p.index, overlaps: p.overlaps }));
    const newTags = [...new Set(planned.flatMap((p) => p.newTags))];
    const quotaBefore = await remainingIn('workspace');

    if (dry_run) {
      return {
        dry_run: true,
        would_create: todo.map((p) => ({ index: p.index, entry: p.summary, hours: hours(p.write.duration) })),
        skipped_duplicates: skipped,
        overlaps,
        new_tags: newTags,
        requests_needed: todo.length,
        quota: quotaNote(quotaBefore),
      };
    }

    const created: { index: number; id: number; entry: string }[] = [];
    const notCreated: { index: number; entry: string; reason: string }[] = [];
    let quota: ResponseQuota | { remaining: number; resetsInSec: number } | null = quotaBefore;
    const started = Date.now();
    let stopReason: string | null = null;

    for (const p of todo) {
      if (stopReason === null) {
        if (quota && quota.remaining <= QUOTA_RESERVE) {
          stopReason = `quota: ${quota.remaining} requests left, kept for the dashboard; resets in ${Math.ceil(quota.resetsInSec / 60)} min`;
        } else if (Date.now() - started > WRITE_DEADLINE_MS) {
          stopReason = 'time: call again for the rest';
        }
      }
      if (stopReason !== null) {
        notCreated.push({ index: p.index, entry: p.summary, reason: stopReason });
        continue;
      }
      try {
        if (created.length > 0) await sleep(WRITE_SPACING_MS);
        const res = await createEntry(account.workspaceId, p.write);
        quota = res.quota ?? quota;
        created.push({ index: p.index, id: res.data.id, entry: p.summary });
        await audit(ctx, {
          tool: 'create_time_entries',
          action: 'create',
          entryId: res.data.id,
          after: compactEntry(res.data, account, Date.now()),
        });
      } catch (e) {
        if (isQuotaError(e)) {
          stopReason = `quota: Toggl refused (HTTP ${e.status}); resets in ${Math.ceil((e.resetsInSec ?? 3600) / 60)} min`;
          notCreated.push({ index: p.index, entry: p.summary, reason: stopReason });
          continue;
        }
        notCreated.push({ index: p.index, entry: p.summary, reason: (e as Error).message });
      }
    }
    if (created.length) await invalidateEntries();

    return {
      created,
      not_created: notCreated,
      skipped_duplicates: skipped,
      overlaps,
      new_tags: newTags,
      quota: quotaNote(quota),
    };
  },
});

// ─── update_time_entries ────────────────────────────────────────────────────

const updateInput = z.object({
  id: z.number().int(),
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

/** The full write for one update, from the entry's current state. */
function planUpdate(
  u: UpdateInput,
  before: TimeEntry,
  account: TogglAccount,
  allowNewTags: boolean
): { write: Partial<EntryWrite>; changes: Record<string, { from: unknown; to: unknown }> } {
  if (before.duration < 0 || !before.stop) throw new ToolError(`Entry ${u.id} is running; stop it in Toggl first.`);
  const write: Partial<EntryWrite> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const beforeStart = Date.parse(before.start);
  const beforeStop = Date.parse(before.stop);

  if (u.start !== undefined || u.stop !== undefined || u.duration_minutes !== undefined) {
    if (u.stop !== undefined && u.duration_minutes !== undefined) {
      throw new ToolError(`Entry ${u.id}: give stop or duration_minutes, not both.`);
    }
    const start = u.start ?? fmtLocal(beforeStart);
    const keepLength = u.stop === undefined && u.duration_minutes === undefined;
    const times = resolveTimes(
      start,
      keepLength ? undefined : u.stop,
      keepLength ? (beforeStop - beforeStart) / 60000 : u.duration_minutes
    );
    if (!times.ok) throw new ToolError(`Entry ${u.id}: ${times.error}`);
    const { startMs, stopMs } = times.value;
    if (startMs !== beforeStart || stopMs !== beforeStop) {
      write.start = new Date(startMs).toISOString();
      write.stop = new Date(stopMs).toISOString();
      write.duration = Math.round((stopMs - startMs) / 1000);
      changes.time = {
        from: `${fmtLocal(beforeStart)}–${fmtLocal(beforeStop).slice(11)}`,
        to: `${fmtLocal(startMs)}–${fmtLocal(stopMs).slice(11)}`,
      };
    }
  }
  if (u.description !== undefined && u.description.trim() !== (before.description ?? '').trim()) {
    write.description = u.description.trim();
    changes.description = { from: before.description ?? '', to: write.description };
  }
  if (u.project !== undefined) {
    const r = resolveProject(account, u.project);
    if (!r.ok) throw new ToolError(`Entry ${u.id}: ${r.error}`);
    if (r.value.id !== before.project_id) {
      write.project_id = r.value.id;
      changes.project = {
        from: account.projects.find((p) => p.id === before.project_id)?.name ?? before.project_id,
        to: r.value.name,
      };
    }
  }
  if (u.tags !== undefined || u.add_tags !== undefined || u.remove_tags !== undefined) {
    const current = before.tags ?? [];
    const base = u.tags !== undefined ? u.tags : current;
    const resolved = resolveTags(account, [...base, ...(u.add_tags ?? [])], allowNewTags);
    if (resolved.errors.length) throw new ToolError(`Entry ${u.id}: ${resolved.errors.join(' ')}`);
    const removed = new Set(
      (u.remove_tags ?? []).map((t) => {
        const r = resolveTags(account, [t], true);
        return r.tags[0] ?? t;
      })
    );
    const next = resolved.tags.filter((t) => !removed.has(t));
    if ([...next].sort().join('\u0000') !== [...current].sort().join('\u0000')) {
      write.tags = next;
      changes.tags = { from: current, to: next };
    }
  }
  if (u.billable !== undefined && u.billable !== (before as TimeEntry & { billable?: boolean }).billable) {
    write.billable = u.billable;
    changes.billable = { from: (before as TimeEntry & { billable?: boolean }).billable ?? null, to: u.billable };
  }
  return { write, changes };
}

const updateTimeEntries = defineTool({
  name: 'update_time_entries',
  title: 'Update time entries',
  description:
    `Change up to ${MAX_BATCH} existing entries (by id from list_time_entries): time, description, project, tags. ` +
    'Fields not given stay as they are; changing start alone moves the entry and keeps its length. ' +
    "Each changed entry is one Toggl request (plus one to read it when it isn't in a recent list). " +
    `Stops at ${QUOTA_RESERVE} requests left, like create_time_entries. Nothing here deletes entries.`,
  access: 'write',
  input: {
    updates: z.array(updateInput).min(1).max(MAX_BATCH),
    allow_new_tags: z.boolean().optional(),
    dry_run: z.boolean().optional(),
  },
  handler: async ({ updates, allow_new_tags, dry_run }, ctx: ToolContext) => {
    const { value: account } = await getAccount();
    const plans = [];
    for (const u of updates as UpdateInput[]) {
      const before = await getEntry(u.id);
      plans.push({ u, before, ...planUpdate(u, before, account, !!allow_new_tags) });
    }
    const changing = plans.filter((p) => Object.keys(p.changes).length > 0);
    const unchanged = plans.filter((p) => Object.keys(p.changes).length === 0).map((p) => p.u.id);
    let quota: ResponseQuota | { remaining: number; resetsInSec: number } | null = await remainingIn('workspace');

    if (dry_run) {
      return {
        dry_run: true,
        would_update: changing.map((p) => ({ id: p.u.id, changes: p.changes })),
        unchanged,
        requests_needed: changing.length,
        quota: quotaNote(quota),
      };
    }

    const updated: { id: number; changes: Record<string, unknown> }[] = [];
    const notUpdated: { id: number; reason: string }[] = [];
    const started = Date.now();
    let stopReason: string | null = null;
    for (const p of changing) {
      if (stopReason === null) {
        if (quota && quota.remaining <= QUOTA_RESERVE) {
          stopReason = `quota: ${quota.remaining} requests left, kept for the dashboard; resets in ${Math.ceil(quota.resetsInSec / 60)} min`;
        } else if (Date.now() - started > WRITE_DEADLINE_MS) {
          stopReason = 'time: call again for the rest';
        }
      }
      if (stopReason !== null) {
        notUpdated.push({ id: p.u.id, reason: stopReason });
        continue;
      }
      try {
        if (updated.length > 0) await sleep(WRITE_SPACING_MS);
        const res = await updateEntry(account.workspaceId, p.u.id, p.write);
        quota = res.quota ?? quota;
        updated.push({ id: p.u.id, changes: p.changes });
        await audit(ctx, {
          tool: 'update_time_entries',
          action: 'update',
          entryId: p.u.id,
          before: compactEntry(p.before, account, Date.now()),
          after: compactEntry(res.data, account, Date.now()),
        });
      } catch (e) {
        if (isQuotaError(e)) {
          stopReason = `quota: Toggl refused (HTTP ${e.status}); resets in ${Math.ceil((e.resetsInSec ?? 3600) / 60)} min`;
          notUpdated.push({ id: p.u.id, reason: stopReason });
          continue;
        }
        notUpdated.push({ id: p.u.id, reason: (e as Error).message });
      }
    }
    if (updated.length) await invalidateEntries();
    return { updated, not_updated: notUpdated, unchanged, quota: quotaNote(quota) };
  },
});

export const entryTools = [listTimeEntries, createTimeEntries, updateTimeEntries];
