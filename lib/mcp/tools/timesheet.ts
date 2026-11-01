// The timesheet for a stored workspace, exactly as the Timesheet page and the
// export dialog compute it, plus what the page flags.

import { z } from 'zod';
import { wholeWeeksRange } from '@/lib/export/range';
import { getAccount, getEntries } from '@/lib/toggl/server';
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
    'them and before exporting. Whole weeks are loaded, so a range that starts or ends mid-week shows each day as the ' +
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
    fresh: z.boolean().optional().describe('Bypass the 2-minute entries cache.'),
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
    const [{ value: account }, entries] = await Promise.all([
      getAccount(),
      getEntries(new Date(load.fromMs).toISOString(), new Date(load.toMs).toISOString(), fresh ? 0 : undefined),
    ]);
    const { doc, checks } = buildTimesheet({
      workspace: ws,
      accountName: account.fullname,
      entries: entries.value,
      fromMs: range.fromMs,
      toMs: range.toMs,
      view,
      nowMs: Date.now(),
    });
    return {
      workspace: describeWorkspace(ws),
      data_at: fmtLocal(entries.atMs),
      timesheet: compactDoc(doc),
      checks,
      ...(format === 'csv' ? { csv: toCSV(doc).replace(/^﻿/, '') } : {}),
    };
  },
});

export const timesheetTools = [getTimesheet];
