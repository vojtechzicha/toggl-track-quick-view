// Builds a format-agnostic export document from raw Toggl entries, using the SAME
// pure builders the on-screen timesheet views use. CSV/XLSX/PDF all serialize this
// one structure, so every export shows exactly what the view would (rounding,
// grouping, warnings and all). Hours are carried as rounded *seconds*; each format
// decides how to render them (decimal hours for the technical formats, the view's
// "h" label for PDF).

import { fmtHours, fmtTimeOfDay, type TimeEntry } from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { buildSummaryGrid } from '@/lib/timesheet/summary';
import { buildIndividualWeek } from '@/lib/timesheet/individual';
import { fitDescs } from '@/lib/timesheet/desc';
import type { CodeMapping } from '@/lib/timesheet/mapping';
import { DAY_LABELS, DAY_MS, UNTAGGED, MULTIPLE } from '@/lib/timesheet/constants';
import { weeksInRange, type DateRange } from './range';

export type ExportView = 'summary' | 'individual';

/**
 * What the agreed rate is quoted per: an hour of work, or a man-day (MD, the
 * eight-hour day of lib/export/pdf/money). Contracts state one or the other,
 * and the fee wording in the PDF report follows the contract's own unit.
 */
export type RateBasis = 'hourly' | 'md';

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
  /**
   * Grid the Individual view's start times anchor to, in seconds; omitted/finer
   * than the rounding unit = the rounding unit itself (see lib/timesheet/individual).
   */
  startWindowSeconds?: number | null;
  /** Optional cap (characters) on every merged description; null/omitted = no limit. */
  maxDescriptionLength?: number | null;
  /** When true, cap each week's billable total at `weeklyHours` (overtime unbilled). */
  noOvertime: boolean;
  /** Weekly cap (hours) the overtime trim reduces the billed total to. */
  weeklyHours: number;
  /** Tag marking a time-off entry (its day is a holiday; the entry never exports). */
  timeOffTag?: string;
  /** Linked billing codes (see lib/timesheet/mapping); empty/omitted = none. */
  codeMappings?: CodeMapping[];
  /**
   * When true, billing codes export without their parenthetical groups (the
   * "(X)"/"(!)" markers are interpreted first, then the strip runs).
   */
  stripCodeParens?: boolean;
  /**
   * When true, the workspace bills by project rather than by billing code:
   * every row's code IS its project name, and no billing-code machinery
   * (tickets, markers, the strip, linked codes) applies.
   */
  billByProject?: boolean;
  /** Title shown on the document (project / group name). */
  title: string;
  /** Person the timesheet is for (may be empty). */
  personName: string;
  /** Person's role (used by templates with an identity header; may be empty). */
  role?: string;
  /** Person's company (used by templates with an identity header; may be empty). */
  company?: string;
  /** Client the report is addressed to (report template; may be empty). */
  client?: string;
  /** Approver named under the sign-off block (report template; may be empty). */
  approver?: string;
  /** Document reference printed on every page; empty = the template's default. */
  reference?: string;
  /**
   * Free-text sentence naming the contract, order and end customer this period
   * was worked under. Written by the user in the template's own language and
   * printed verbatim at the top of the basis-of-preparation block; the standing
   * wording around it belongs to the template. Empty = omitted.
   */
  engagement?: string;
  /** Agreed rate for fee lines (per `rateBasis`); null/omitted = a time-only document. */
  rate?: number | null;
  /** Unit the rate is quoted per; omitted = hourly. Meaningful only with a rate. */
  rateBasis?: RateBasis;
  /** ISO 4217 code the rate is in (e.g. "CZK"); meaningful only with a rate. */
  currency?: string;
}

export interface ExportMeta {
  view: ExportView;
  title: string;
  personName: string;
  role: string;
  company: string;
  client: string;
  approver: string;
  /** Document reference printed on every page; empty = the template's default. */
  reference: string;
  /** Engagement sentence for the basis-of-preparation block; empty = omitted. */
  engagement: string;
  /** Agreed rate for fee lines (per `rateBasis`); null = a time-only document. */
  rate: number | null;
  /** Unit the rate is quoted per — an hour, or a man-day. */
  rateBasis: RateBasis;
  currency: string;
  fromMs: number;
  toMs: number; // exclusive
  multi: boolean;
  /**
   * True when the document's billing lines are PROJECTS, not billing codes —
   * `billingCode` then holds the project's name and equals `project`. A
   * template that heads its billing column can say so ("Project" rather than
   * "Billing code"); one that ignores it prints correct figures either way,
   * since the codes it prints are simply project names.
   *
   * OPTIONAL on purpose, unlike every other field here: a template PACK is a
   * separate repository compiled into this one (see README → "Private template
   * packs"), and its typed ExportDoc fixtures are type-checked by `next build`.
   * A required field would deadlock the two repos — a pack that hasn't added it
   * fails to build here, and a pack that adds it early fails against the app
   * that hasn't. Optional, either merges in any order. `buildExportDoc` always
   * sets it, so absent means false; read it as truthy.
   */
  billByProject?: boolean;
}

// ---- Summary shape ----
export interface SummaryRow {
  label: string; // "Project: D123" / "D123" / warning text
  /** Unprefixed billing code, for templates that lay code and project out separately. */
  billingCode: string;
  /** Project the row's code belongs to ("" when unknown). */
  project: string;
  warn: boolean;
  /** Rounded seconds per visible day column (0 = empty). */
  cells: number[];
  /**
   * Combined description for the row across the week (deduped, "; "-joined,
   * fitted within the optional length limit).
   */
  desc: string;
  /** Per-visible-day description (aligned with `cells`; "" where no time). */
  dayDescs: string[];
  total: number;
}
export interface SummaryWeekBlock {
  weekStart: number;
  label: string; // "Jun 7 – Jun 13"
  dayLabels: string[]; // header for each visible day column
  /** Local-midnight ms of each visible day column (aligned with `dayLabels`). */
  dayDates: number[];
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
  time: string | null; // "09:00–10:30" in the *device* locale, or null for warnings
  /**
   * Raw start/end of the entry. Templates that print in a fixed locale (the
   * report's EN/CZ pair) format these themselves — `time` follows whatever
   * locale the browser is set to, which is wrong for a Czech document produced
   * on an en-US machine.
   */
  startMs: number | null;
  endMs: number | null;
  hours: number; // rounded seconds
  code: string; // billing code (with project prefix when multi) or warning label
  /** Unprefixed billing code, for templates that lay code and project out separately. */
  billingCode: string;
  /** Project the row belongs to ("" when unknown). */
  project: string;
  warn: boolean;
  desc: string;
}
export interface IndividualDayBlock {
  dateMs: number;
  label: string; // "Sat · Jun 7"
  total: number;
  rows: IndividualRow[]; // billable lines only — warnings stay in the on-screen view
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
  const { range, entries, nowMs, projects, multi, billingTagPrefix, roundingSeconds, maxDescriptionLength, noOvertime, weeklyHours, timeOffTag, codeMappings, stripCodeParens, billByProject } = o;
  const weeks: SummaryWeekBlock[] = [];
  // Billing by project the code already IS the project name, so the
  // disambiguating "Project: " prefix would only repeat it.
  const prefixProject = multi && !billByProject;

  for (const weekStart of weeksInRange(range.fromMs, range.toMs)) {
    const grid = buildSummaryGrid({
      entries,
      weekStart,
      nowMs,
      projects,
      billingTagPrefix,
      roundingSeconds,
      maxDescriptionLength,
      noOvertime,
      weeklyHours,
      timeOffTag,
      codeMappings,
      stripCodeParens,
      billByProject,
    });
    if (!grid || grid.rows.length === 0) continue;

    // Keep only day columns whose date falls inside the requested range, so the
    // edge weeks of a month don't bleed into the neighbouring month.
    const dayCols = grid.dayCols.filter((d) => {
      const dayMs = weekStart + d * DAY_MS;
      return dayMs >= range.fromMs && dayMs < range.toMs;
    });
    if (dayCols.length === 0) continue;

    // Billable rows only — warning rows (no/multiple billing tag) are an on-screen
    // hint to fix Toggl, never part of the exported timesheet.
    const rows: SummaryRow[] = grid.rows
      .filter((rowKey) => rowKey !== UNTAGGED && rowKey !== MULTIPLE)
      .map((rowKey) => {
        const meta = grid.rowMeta.get(rowKey);
        const label = codeLabel(meta?.projectName, meta?.tag, prefixProject);
        const cells = dayCols.map((d) => grid.rounded.get(`${d}|${rowKey}`) ?? 0);
        // Aggregate this row's descriptions across the visible days (deduped),
        // then fit the week-level join within the same length limit the per-day
        // cells honour — this column is one field in the exported file too.
        const descs: string[] = [];
        for (const d of dayCols) {
          for (const desc of grid.cells.get(`${d}|${rowKey}`)?.descs ?? []) {
            if (!descs.some((x) => x.toLowerCase() === desc.toLowerCase())) descs.push(desc);
          }
        }
        // Per-day text too (cell descs are already deduped) — day-based templates
        // need the descriptions of exactly one day, not the week-level join.
        const dayDescs = dayCols.map((d) =>
          fitDescs(grid.cells.get(`${d}|${rowKey}`)?.descs ?? [], maxDescriptionLength).text
        );
        const total = cells.reduce((s, v) => s + v, 0);
        return {
          label,
          billingCode: meta?.tag ?? '',
          // Billing by project the two are the same field, and the row's code
          // has already been through the nameless-project fallback (see
          // projectBillingCode) — so take it from there rather than from the
          // raw name, or a template printing `project` would show a blank
          // where the billing column shows the fallback.
          project: (billByProject ? meta?.tag : meta?.projectName) ?? '',
          warn: false,
          cells,
          desc: fitDescs(descs, maxDescriptionLength).text,
          dayDescs,
          total,
        };
      });
    // Drop rows that are entirely outside the kept columns (no time anywhere).
    const keptRows = rows.filter((r) => r.total > 0);
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
      dayDates: dayCols.map((d) => weekStart + d * DAY_MS),
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
    role: o.role ?? '',
    company: o.company ?? '',
    client: o.client ?? '',
    approver: o.approver ?? '',
    reference: o.reference ?? '',
    engagement: o.engagement ?? '',
    rate: o.rate ?? null,
    rateBasis: o.rateBasis ?? 'hourly',
    currency: o.currency ?? '',
    fromMs: range.fromMs,
    toMs: range.toMs,
    multi,
    billByProject: !!billByProject,
    weeks,
    grandTotal,
  };
}

function buildIndividualDoc(o: ExportOptions): IndividualDoc {
  const { range, entries, nowMs, projects, multi, maxBillableHours, billingTagPrefix, roundingSeconds, startWindowSeconds, maxDescriptionLength, noOvertime, weeklyHours, timeOffTag, codeMappings, stripCodeParens, billByProject } = o;
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const days: IndividualDayBlock[] = [];
  // Billing by project the code already IS the project name, so the
  // disambiguating "Project: " prefix would only repeat it.
  const prefixProject = multi && !billByProject;

  for (const weekStart of weeksInRange(range.fromMs, range.toMs)) {
    const week = buildIndividualWeek({
      entries,
      weekStart,
      nowMs,
      projects,
      maxBillableHours,
      billingTagPrefix,
      roundingSeconds,
      startWindowSeconds,
      maxDescriptionLength,
      noOvertime,
      weeklyHours,
      timeOffTag,
      codeMappings,
      stripCodeParens,
      billByProject,
    });
    if (!week) continue;
    for (const day of week.days) {
      // Clip to the requested range (drops edge-week days outside the month).
      if (day.dateMs < range.fromMs || day.dateMs >= range.toMs) continue;
      const dateLabel = new Date(day.dateMs).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      // Billable lines only — warning rows and overlap flags are on-screen hints to
      // fix Toggl, never part of the exported timesheet.
      const rows: IndividualRow[] = day.rows
        .filter((row) => row.kind === 'bill')
        .map((row) => ({
          time: `${fmtTimeOfDay(row.startMs as number)}–${fmtTimeOfDay(row.endMs as number)}`,
          startMs: row.startMs ?? null,
          endMs: row.endMs ?? null,
          hours: row.rounded,
          code: codeLabel(
            row.projId != null ? nameById.get(row.projId) : undefined,
            row.code,
            prefixProject
          ),
          billingCode: row.code ?? '',
          // As in the summary: billing by project these are one field, and the
          // code already carries the nameless-project fallback.
          project:
            (billByProject
              ? row.code
              : row.projId != null
              ? nameById.get(row.projId)
              : undefined) ?? '',
          warn: false,
          desc: row.desc,
        }));
      if (rows.length === 0) continue;
      days.push({
        dateMs: day.dateMs,
        label: `${DAY_LABELS[day.dayIdx]} · ${dateLabel}`,
        total: day.total,
        rows,
      });
    }
  }

  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  return {
    view: 'individual',
    title: o.title,
    personName: o.personName,
    role: o.role ?? '',
    company: o.company ?? '',
    client: o.client ?? '',
    approver: o.approver ?? '',
    reference: o.reference ?? '',
    engagement: o.engagement ?? '',
    rate: o.rate ?? null,
    rateBasis: o.rateBasis ?? 'hourly',
    currency: o.currency ?? '',
    fromMs: range.fromMs,
    toMs: range.toMs,
    multi,
    billByProject: !!billByProject,
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
