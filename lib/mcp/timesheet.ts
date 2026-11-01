// The timesheet as the app shows and exports it, built on the server for the
// MCP tools: the same builders as the Timesheet page (lib/timesheet) and the
// export dialog (lib/export/model), fed with a stored workspace's settings
// from the settings-sync document. Requires the process's local zone to be
// the app's (lib/mcp/time.ts).

import type { TimeEntry } from '@/lib/calc';
import {
  effectiveMaxBillableHours,
  roundingUnitSeconds,
  startWindowUnitSeconds,
  DEFAULT_TIME_OFF_TAG,
} from '@/lib/calc';
import type { PresetValue, SettingsPreset } from '@/components/SettingsPanel';
import { buildExportDoc, type ExportDoc, type ExportView } from '@/lib/export/model';
import { weeksInRange } from '@/lib/export/range';
import { toCSV } from '@/lib/export/csv';
import { buildIndividualWeek } from '@/lib/timesheet/individual';
import { warnLabel } from '@/lib/timesheet/individual';
import type { SyncPayload } from '@/lib/sync/model';
import { fmtClock, fmtDate, hours } from './time';

export interface WorkspaceRef {
  /** Preset id, or null for the synced active settings that match no preset. */
  id: string | null;
  name: string;
  value: PresetValue;
}

const lc = (s: string) => s.trim().toLowerCase();

/** The presets plus the active settings, from the settings-sync payload. */
export function workspacesOf(payload: SyncPayload | null): {
  presets: SettingsPreset[];
  active: WorkspaceRef | null;
} {
  if (!payload) return { presets: [], active: null };
  const settings = payload.settings as SyncPayload['settings'];
  const presets = (settings.presets ?? []) as SettingsPreset[];
  const activePreset = presets.find((p) => p.id === settings.activePresetId);
  return {
    presets,
    active: {
      id: activePreset?.id ?? null,
      name: activePreset?.name ?? 'Current settings',
      value: settings as unknown as PresetValue,
    },
  };
}

/** A stored workspace by id or name; the active settings when `input` is empty. */
export function resolveWorkspace(payload: SyncPayload | null, input?: string): WorkspaceRef {
  const { presets, active } = workspacesOf(payload);
  if (!input?.trim()) {
    if (!active) throw new Error('No synced settings yet. Open the app once with settings sync on.');
    return active;
  }
  const match =
    presets.find((p) => p.id === input) ??
    presets.find((p) => p.name === input.trim()) ??
    presets.find((p) => lc(p.name) === lc(input));
  if (!match) {
    const names = presets.map((p) => `"${p.name}"`).join(', ') || 'none';
    throw new Error(`Unknown workspace "${input}". Stored workspaces: ${names}.`);
  }
  return { id: match.id, name: match.name, value: match.value };
}

/** What a workspace is set up to do, without its export identity details. */
export function describeWorkspace(w: WorkspaceRef) {
  const v = w.value;
  const fields = v.exportFields;
  return {
    id: w.id,
    name: w.name,
    projects: v.selectedProjects.map((p) => ({ id: p.id, name: p.name })),
    group_name: v.groupName || null,
    weekly_hours: v.weeklyHours,
    short_friday: v.shortFriday,
    billing_tag_prefix: v.billingTagPrefix,
    bill_by_project: !!v.billByProject,
    rounding_minutes: Math.round(v.roundingHours * 60),
    start_window_minutes: v.startWindowHours ? Math.round(v.startWindowHours * 60) : null,
    max_billable_hours: effectiveMaxBillableHours(v),
    max_description_length: v.maxDescriptionLength ?? null,
    no_overtime: v.noOvertime,
    balance_weekdays: !!v.balanceWeekdays,
    time_off_tag: v.timeOffTag || DEFAULT_TIME_OFF_TAG,
    strip_code_parens: !!v.stripCodeParens,
    linked_codes: (v.codeMappings ?? []).map((m) => ({
      project_id: m.projectId,
      tag_prefix: m.tagPrefix,
      bills_as: m.targetCode,
      rounding_minutes: Math.round(m.roundingHours * 60),
    })),
    timesheet_view: v.timesheetMode,
    engagement_start_date: fields?.startDate || null,
  };
}

const parseRate = (s: string | undefined): number | null => {
  const n = Number((s ?? '').replace(',', '.').trim());
  return s && s.trim() && Number.isFinite(n) && n > 0 ? n : null;
};

export interface TimesheetResult {
  doc: ExportDoc;
  checks: ReturnType<typeof timesheetChecks>;
}

/**
 * The export document for [fromMs, toMs) and the on-screen checks. `entries`
 * must cover every week the range touches in full (wholeWeeksRange), as the
 * export dialog loads them.
 */
export function buildTimesheet(opts: {
  workspace: WorkspaceRef;
  accountName: string;
  entries: TimeEntry[];
  fromMs: number;
  toMs: number;
  view?: ExportView;
  nowMs: number;
}): TimesheetResult {
  const v = opts.workspace.value;
  const sel = v.selectedProjects;
  const multi = sel.length > 1;
  const roundingSeconds = roundingUnitSeconds(v.roundingHours);
  const startWindowSeconds = startWindowUnitSeconds(v.startWindowHours, roundingSeconds);
  const f = v.exportFields;
  const common = {
    entries: opts.entries,
    nowMs: opts.nowMs,
    projects: sel,
    maxBillableHours: effectiveMaxBillableHours(v),
    billingTagPrefix: v.billingTagPrefix,
    roundingSeconds,
    startWindowSeconds,
    maxDescriptionLength: v.maxDescriptionLength,
    noOvertime: v.noOvertime,
    weeklyHours: v.weeklyHours,
    balanceWeekdays: v.balanceWeekdays,
    timeOffTag: v.timeOffTag,
    codeMappings: v.codeMappings,
    stripCodeParens: v.stripCodeParens,
    billByProject: v.billByProject,
  };
  const doc = buildExportDoc({
    ...common,
    view: opts.view ?? v.timesheetMode,
    range: { fromMs: opts.fromMs, toMs: opts.toMs },
    multi,
    title: multi ? v.groupName || 'Multiple projects' : sel[0]?.name || 'No project',
    personName: v.exportName.trim() || opts.accountName,
    role: f?.role ?? '',
    company: f?.company ?? '',
    client: f?.client ?? '',
    approver: f?.approver ?? '',
    reference: f?.reference ?? '',
    rate: parseRate(f?.rate),
    rateBasis: f?.rateBasis === 'md' ? 'md' : 'hourly',
    currency: (f?.currency ?? '').toUpperCase(),
  });
  return { doc, checks: timesheetChecks({ ...common, fromMs: opts.fromMs, toMs: opts.toMs }) };
}

/**
 * What the Timesheet page flags, per day in range: warning rows (no billing
 * tag, several, too long to bill alone), overlaps, time trimmed by the
 * overtime cap, time moved by balancing, and holidays.
 */
function timesheetChecks(
  o: Omit<Parameters<typeof buildIndividualWeek>[0], 'weekStart'> & { fromMs: number; toMs: number }
) {
  const { fromMs, toMs, ...input } = o;
  const warnings: { date: string; kind: string; minutes: number; desc: string }[] = [];
  const overlaps: { date: string; detail: string }[] = [];
  const overtime: { date: string; hours: number }[] = [];
  const balanced: { date: string; hours: number }[] = [];
  const holidays: { date: string; billed: boolean }[] = [];
  const dayTotals: { date: string; billed_hours: number }[] = [];

  for (const weekStart of weeksInRange(fromMs, toMs)) {
    const week = buildIndividualWeek({ ...input, weekStart });
    if (!week) continue;
    for (const day of week.days) {
      if (day.dateMs < fromMs || day.dateMs >= toMs) continue;
      const date = fmtDate(day.dateMs);
      for (const row of day.rows) {
        if (row.kind !== 'warn' || !row.warn) continue;
        warnings.push({
          date,
          kind: warnLabel(row.warn, input.maxBillableHours),
          minutes: Math.round(row.seconds / 60),
          desc: row.desc,
        });
      }
      for (const detail of day.overlaps) overlaps.push({ date, detail });
      if (day.overtime > 0) overtime.push({ date, hours: hours(day.overtime) });
      if (day.balanced !== 0) balanced.push({ date, hours: hours(day.balanced) });
      if (day.holiday) holidays.push({ date, billed: day.holidayBilled });
      if (day.total > 0) dayTotals.push({ date, billed_hours: hours(day.total) });
    }
  }
  return {
    ok: warnings.length === 0 && overlaps.length === 0,
    warnings,
    overlaps,
    overtime_trimmed: overtime,
    balanced,
    holidays,
    day_totals: dayTotals,
  };
}

/** The export document in a compact shape for the agent (hours, local times). */
export function compactDoc(doc: ExportDoc) {
  const base = {
    view: doc.view,
    title: doc.title,
    person: doc.personName,
    from: fmtDate(doc.fromMs),
    to: fmtDate(doc.toMs - 1),
    total_hours: hours(doc.grandTotal),
  };
  if (doc.view === 'summary') {
    return {
      ...base,
      weeks: doc.weeks.map((w) => ({
        label: w.label,
        days: w.dayDates.map(fmtDate),
        rows: w.rows.map((r) => ({
          code: r.label,
          hours_per_day: r.cells.map(hours),
          total: hours(r.total),
          desc: r.desc,
          day_descs: r.dayDescs,
        })),
        day_totals: w.dayTotals.map(hours),
        total: hours(w.grandTotal),
      })),
    };
  }
  return {
    ...base,
    days: doc.days.map((d) => ({
      date: fmtDate(d.dateMs),
      total: hours(d.total),
      rows: d.rows.map((r) => ({
        time: r.startMs !== null && r.endMs !== null ? `${fmtClock(r.startMs)}–${fmtClock(r.endMs)}` : null,
        hours: hours(r.hours),
        code: r.code,
        desc: r.desc,
      })),
    })),
  };
}

export { toCSV };
