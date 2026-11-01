// The timesheet for a stored workspace, exactly as the Timesheet page and the
// export dialog compute it, plus what the page flags.

import { z } from 'zod';
import { wholeWeeksRange } from '@/lib/export/range';
import { getAccount } from '@/lib/toggl/server';
import { readMirror } from '@/lib/mirror/read';
import { statusOf, toTimeEntry } from '@/lib/mirror/model';
import { readSyncPayload } from '@/lib/sync/server';
import { dateRange, fmtLocal } from '../time';
import { ToolError, defineTool } from '../tool-kit';
import { buildTimesheet, compactDoc, describeWorkspace, resolveWorkspace, toCSV } from '../timesheet';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const getTimesheet = defineTool({
  name: 'get_timesheet',
  title: 'Get timesheet',
  description:
    "A stored workspace's timesheet for a date range, computed exactly as the app's Timesheet page and exports do " +
    '(rounding, merging, overtime cap, balancing, linked codes, time off), plus the checks the page flags: entries ' +
    'without a billing tag, with several, too long to bill alone, overlapping. Use it to verify entries after writing ' +
    'them and before exporting; entries still waiting for Toggl are included (see entries_not_yet_in_toggl). Whole weeks are loaded, so a range that starts or ends mid-week shows each day as the ' +
    'screen does. format "csv" also returns the CSV export. PDF export and signing stay in the app (track.zicha.dev/timesheet).',
  access: 'read',
  input: {
    workspace: z
      .string()
      .optional()
      .describe('Stored workspace name or id (see get_context). Default: the active settings.'),
    from: date,
    to: date.describe('Inclusive.'),
    view: z.enum(['summary', 'individual']).optional().describe("Default: the workspace's own view."),
    format: z.enum(['json', 'csv']).optional(),
    fresh: z.boolean().optional().describe('Read Toggl now instead of using a recent copy.'),
  },
  handler: async ({ workspace, from, to, view, format, fresh }) => {
    let range;
    try {
      range = dateRange(from, to);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    const payload = await readSyncPayload();
    let ws;
    try {
      ws = resolveWorkspace(payload, workspace);
    } catch (e) {
      throw new ToolError((e as Error).message);
    }
    if (ws.value.selectedProjects.length === 0) {
      throw new ToolError(`Workspace "${ws.name}" tracks no project.`);
    }
    const load = wholeWeeksRange(range);
    const [{ value: account }, read] = await Promise.all([getAccount(), readMirror(load.fromMs, load.toMs, { fresh })]);
    const selected = new Set(ws.value.selectedProjects.map((p) => p.id));
    const notInToggl = read.docs.filter(
      (d) =>
        d.fields.project_id !== null &&
        selected.has(d.fields.project_id) &&
        Date.parse(d.fields.start) >= range.fromMs &&
        Date.parse(d.fields.start) < range.toMs &&
        statusOf(d) !== 'synced'
    ).length;
    const { doc, checks } = buildTimesheet({
      workspace: ws,
      accountName: account.fullname,
      entries: read.docs.map(toTimeEntry),
      fromMs: range.fromMs,
      toMs: range.toMs,
      view,
      nowMs: Date.now(),
    });
    return {
      workspace: describeWorkspace(ws),
      toggl_read_at: read.dataAtMs ? fmtLocal(read.dataAtMs) : null,
      ...(read.warning ? { warning: read.warning } : {}),
      // Included in the figures; Toggl (and anything reading it directly) does not have them yet.
      entries_not_yet_in_toggl: notInToggl,
      timesheet: compactDoc(doc),
      checks,
      ...(format === 'csv' ? { csv: toCSV(doc).replace(/^﻿/, '') } : {}),
    };
  },
});

export const timesheetTools = [getTimesheet];
