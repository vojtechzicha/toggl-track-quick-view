// Builds a format-agnostic export document from raw Toggl entries, using the SAME
// pure builders the on-screen timesheet views use. CSV/XLSX/PDF all serialize this
// one structure, so every export shows exactly what the view would (rounding,
// grouping, warnings and all). Hours are carried as rounded *seconds*; each format
// decides how to render them (decimal hours for the technical formats, the view's
// "h" label for PDF).

import { fmtHours, fmtTimeOfDay, type TimeEntry } from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { buildSummaryGrid } from '@/lib/timesheet/summary';
import { buildIndividualWeek, warnLabel, type WarnKind } from '@/lib/timesheet/individual';
import { DAY_LABELS, DAY_MS, UNTAGGED, MULTIPLE } from '@/lib/timesheet/constants';
import { weeksInRange, type DateRange } from './range';

export type ExportView = 'summary' | 'individual';

export interface ExportOptions {
  view: ExportView;
  range: DateRange;
  entries: TimeEntry[];
  nowMs: number;
  projects: SelectedProject[];
  multi: boolean;
  maxBillableHours: number;
  billingTagPrefix: string;
  /** Rounding granularity in seconds (900 = 15 min default, 720 = 12 min). */
  roundingSeconds: number;
  /** Title shown on the document (project / group name). */
  title: string;
  /** Person the timesheet is for (may be empty). */
  personName: string;
}

export interface ExportMeta {
  view: ExportView;
  title: string;
  personName: string;
  fromMs: number;
  toMs: number; // exclusive
  multi: boolean;
}

// ---- Summary shape ----
export interface SummaryRow {
  label: string; // "Project: D123" / "D123" / warning text
  warn: boolean;
  /** Rounded seconds per visible day column (0 = empty). */
  cells: number[];
  /** Combined descriptions for the row across the week (deduped). */
  descs: string[];
  total: number;
}
export interface SummaryWeekBlock {
  weekStart: number;
  label: string; // "Jun 7 – Jun 13"
  dayLabels: string[]; // header for each visible day column
  rows: SummaryRow[];
  dayTotals: number[];
  grandTotal: number;
}
export interface SummaryDoc extends ExportMeta {
  view: 'summary';
  weeks: SummaryWeekBlock[];
  grandTotal: number;
}

// ---- Individual shape ----
export interface IndividualRow {
  time: string | null; // "09:00–10:30" or null for warnings
  hours: number; // rounded seconds
  code: string; // billing code (with project prefix when multi) or warning label
  warn: boolean;
  desc: string;
}
export interface IndividualDayBlock {
  dateMs: number;
  label: string; // "Sat · Jun 7"
  total: number;
  rows: IndividualRow[];
  overlaps: string[];
}
export interface IndividualDoc extends ExportMeta {
  view: 'individual';
  days: IndividualDayBlock[];
  grandTotal: number;
}

export type ExportDoc = SummaryDoc | IndividualDoc;

const fmtDay = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Display label for a billable row's billing code, prefixed with the project when multi. */
function codeLabel(
  projectName: string | undefined,
  code: string | undefined,
  multi: boolean
): string {
  return multi && projectName ? `${projectName}: ${code ?? ''}` : code ?? '';
}

function buildSummaryDoc(o: ExportOptions): SummaryDoc {
  const { range, entries, nowMs, projects, multi, billingTagPrefix, roundingSeconds } = o;
  const weeks: SummaryWeekBlock[] = [];

  for (const weekStart of weeksInRange(range.fromMs, range.toMs)) {
    const grid = buildSummaryGrid({ entries, weekStart, nowMs, projects, billingTagPrefix, roundingSeconds });
    if (!grid || grid.rows.length === 0) continue;

    // Keep only day columns whose date falls inside the requested range, so the
    // edge weeks of a month don't bleed into the neighbouring month.
    const dayCols = grid.dayCols.filter((d) => {
      const dayMs = weekStart + d * DAY_MS;
      return dayMs >= range.fromMs && dayMs < range.toMs;
    });
    if (dayCols.length === 0) continue;

    const rows: SummaryRow[] = grid.rows.map((rowKey) => {
      const meta = grid.rowMeta.get(rowKey);
      const warn = rowKey === UNTAGGED || rowKey === MULTIPLE;
      const label = warn
        ? rowKey === UNTAGGED
          ? 'No billing tag'
          : 'Multiple billing tags'
        : codeLabel(meta?.projectName, meta?.tag, multi);
      const cells = dayCols.map((d) => grid.rounded.get(`${d}|${rowKey}`) ?? 0);
      // Aggregate this row's descriptions across the visible days (deduped).
      const descs: string[] = [];
      for (const d of dayCols) {
        for (const desc of grid.cells.get(`${d}|${rowKey}`)?.descs ?? []) {
          if (!descs.some((x) => x.toLowerCase() === desc.toLowerCase())) descs.push(desc);
        }
      }
      const total = cells.reduce((s, v) => s + v, 0);
      return { label, warn, cells, descs, total };
    });
    // Drop rows that are entirely outside the kept columns (no time anywhere).
    const keptRows = rows.filter((r) => r.total > 0 || r.warn);
    if (keptRows.length === 0) continue;

    const dayTotals = dayCols.map((_, ci) => keptRows.reduce((s, r) => s + r.cells[ci], 0));
    const grandTotal = dayTotals.reduce((s, v) => s + v, 0);

    // The heading spans exactly the visible columns: weekdays (Mon–Fri) are always
    // shown — so an empty Friday still extends the label — while weekend days only
    // appear when they carry time. Because `dayCols` is already the visible,
    // range-clipped set, the first and last of them give the right span (and a
    // month export's edge weeks naturally stay within the month).
    const labelFromMs = weekStart + dayCols[0] * DAY_MS;
    const labelToMs = weekStart + dayCols[dayCols.length - 1] * DAY_MS;

    weeks.push({
      weekStart,
      label: `${fmtDay(labelFromMs)} – ${fmtDay(labelToMs)}`,
      dayLabels: dayCols.map((d) => DAY_LABELS[d]),
      rows: keptRows,
      dayTotals,
      grandTotal,
    });
  }

  const grandTotal = weeks.reduce((s, w) => s + w.grandTotal, 0);
  return {
    view: 'summary',
    title: o.title,
    personName: o.personName,
    fromMs: range.fromMs,
    toMs: range.toMs,
    multi,
    weeks,
    grandTotal,
  };
}

function buildIndividualDoc(o: ExportOptions): IndividualDoc {
  const { range, entries, nowMs, projects, multi, maxBillableHours, billingTagPrefix, roundingSeconds } = o;
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const days: IndividualDayBlock[] = [];

  for (const weekStart of weeksInRange(range.fromMs, range.toMs)) {
    const week = buildIndividualWeek({
      entries,
      weekStart,
      nowMs,
      projects,
      maxBillableHours,
      billingTagPrefix,
      roundingSeconds,
    });
    if (!week) continue;
    for (const day of week.days) {
      // Clip to the requested range (drops edge-week days outside the month).
      if (day.dateMs < range.fromMs || day.dateMs >= range.toMs) continue;
      const dateLabel = new Date(day.dateMs).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      const rows: IndividualRow[] = day.rows.map((row) => {
        if (row.kind === 'warn') {
          return {
            time: null,
            hours: row.rounded,
            code: warnLabel(row.warn as WarnKind, maxBillableHours),
            warn: true,
            desc: row.descs.join('; '),
          };
        }
        return {
          time: `${fmtTimeOfDay(row.startMs as number)}–${fmtTimeOfDay(row.endMs as number)}`,
          hours: row.rounded,
          code: codeLabel(
            row.projId != null ? nameById.get(row.projId) : undefined,
            row.code,
            multi
          ),
          warn: false,
          desc: row.descs.join('; '),
        };
      });
      days.push({
        dateMs: day.dateMs,
        label: `${DAY_LABELS[day.dayIdx]} · ${dateLabel}`,
        total: day.total,
        rows,
        overlaps: day.overlaps,
      });
    }
  }

  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  return {
    view: 'individual',
    title: o.title,
    personName: o.personName,
    fromMs: range.fromMs,
    toMs: range.toMs,
    multi,
    days,
    grandTotal,
  };
}

/** Build the export document for the chosen view. */
export function buildExportDoc(o: ExportOptions): ExportDoc {
  return o.view === 'summary' ? buildSummaryDoc(o) : buildIndividualDoc(o);
}

/** True when the document has nothing to export (no rows/days at all). */
export function isEmptyDoc(doc: ExportDoc): boolean {
  return doc.view === 'summary' ? doc.weeks.length === 0 : doc.days.length === 0;
}

// ---- shared formatting helpers for the serializers ----

/** Rounded seconds → decimal hours number (2 dp) for the technical formats. */
export function secsToHoursNum(seconds: number): number {
  return Math.round((Math.max(0, seconds) / 3600) * 100) / 100;
}

/** Rounded seconds → the view's "h" label (e.g. "8.25h") for the PDF. */
export function secsToHoursLabel(seconds: number): string {
  return fmtHours(seconds);
}

/** "Jun 1 – Jun 30, 2026" style period label for document headers / filenames. */
export function periodLabel(fromMs: number, toMs: number): string {
  const from = new Date(fromMs);
  const lastDay = new Date(toMs - DAY_MS); // inclusive last day
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  return `${from.toLocaleDateString(undefined, opts)} – ${lastDay.toLocaleDateString(undefined, opts)}`;
}
