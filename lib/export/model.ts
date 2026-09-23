// Builds a format-agnostic export document from time entries, using the same
// builders as the on-screen timesheet views, so every export matches the view's
// rounding and grouping. CSV, XLSX and PDF all serialize this structure. Hours
// are carried as rounded seconds; each format chooses how to print them.

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
 * Unit the agreed rate is quoted per: an hour, or a man-day (MD, eight hours;
 * see HOURS_PER_MD in lib/export/pdf/money).
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
   * Grid the Individual view's start times snap to, in seconds. Omitted or finer
   * than the rounding unit means the rounding unit (see lib/timesheet/individual).
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
   * Export billing codes without their parenthetical groups. The "(X)"/"(!)"
   * markers are interpreted before the strip.
   */
  stripCodeParens?: boolean;
  /**
   * The workspace bills by project: each row's code is its project name, and
   * tickets, markers, the strip and linked codes do not apply.
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
   * User-written sentence naming the contract, order and end customer, in the
   * template's language. Printed verbatim in the basis-of-preparation block;
   * the template supplies the surrounding text. Empty = omitted.
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
  /** Unit the rate is quoted per. */
  rateBasis: RateBasis;
  currency: string;
  fromMs: number;
  toMs: number; // exclusive
  multi: boolean;
  /**
   * The billing lines are projects rather than billing codes: `billingCode`
   * holds the project name and equals `project`. A template can use this to
   * head its billing column "Project"; ignoring it still prints correct figures.
   *
   * Optional, unlike the other fields, because a template pack is a separate
   * repository whose typed ExportDoc fixtures `next build` type-checks (README →
   * "Private template packs"). A required field would force both repositories
   * to change in lockstep. `buildExportDoc` always sets it; treat absent as false.
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
   * Raw start/end of the entry, for templates that print in a fixed locale.
   * `time` follows the browser's locale.
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
  // Billing by project, the code is the project name, so skip the prefix.
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

    // Keep only day columns inside the range, so a month's edge weeks don't
    // include days from the neighbouring month.
    const dayCols = grid.dayCols.filter((d) => {
      const dayMs = weekStart + d * DAY_MS;
      return dayMs >= range.fromMs && dayMs < range.toMs;
    });
    if (dayCols.length === 0) continue;

    // Billable rows only. Warning rows (no or multiple billing tags) are an
    // on-screen prompt to fix the entries and are never exported.
    const rows: SummaryRow[] = grid.rows
      .filter((rowKey) => rowKey !== UNTAGGED && rowKey !== MULTIPLE)
      .map((rowKey) => {
        const meta = grid.rowMeta.get(rowKey);
        const label = codeLabel(meta?.projectName, meta?.tag, prefixProject);
        const cells = dayCols.map((d) => grid.rounded.get(`${d}|${rowKey}`) ?? 0);
        // Dedupe this row's descriptions across the visible days, then fit the
        // week-level join to the same length limit as the per-day cells.
        const descs: string[] = [];
        for (const d of dayCols) {
          for (const desc of grid.cells.get(`${d}|${rowKey}`)?.descs ?? []) {
            if (!descs.some((x) => x.toLowerCase() === desc.toLowerCase())) descs.push(desc);
          }
        }
        // Per-day text for day-based templates (cell descs are already deduped).
        const dayDescs = dayCols.map((d) =>
          fitDescs(grid.cells.get(`${d}|${rowKey}`)?.descs ?? [], maxDescriptionLength).text
        );
        const total = cells.reduce((s, v) => s + v, 0);
        return {
          label,
          billingCode: meta?.tag ?? '',
          // Billing by project, take the code: it already carries the
          // nameless-project fallback (projectBillingCode), and the raw name
          // would print blank where the billing column shows the fallback.
          project: (billByProject ? meta?.tag : meta?.projectName) ?? '',
          warn: false,
          cells,
          desc: fitDescs(descs, maxDescriptionLength).text,
          dayDescs,
          total,
        };
      });
    // Drop rows with no time in the kept columns.
    const keptRows = rows.filter((r) => r.total > 0);
    if (keptRows.length === 0) continue;

    const dayTotals = dayCols.map((_, ci) => keptRows.reduce((s, r) => s + r.cells[ci], 0));
    const grandTotal = dayTotals.reduce((s, v) => s + v, 0);

    // The heading spans the visible columns. Mon–Fri are always shown, weekend
    // days only when they have time, and `dayCols` is already clipped to the
    // range.
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
  // Billing by project, the code is the project name, so skip the prefix.
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
      // Drop edge-week days outside the range.
      if (day.dateMs < range.fromMs || day.dateMs >= range.toMs) continue;
      const dateLabel = new Date(day.dateMs).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      // Billable lines only; warning rows and overlap flags are never exported.
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
          // As in the summary: billing by project, use the code.
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

/** True when the document has no rows. */
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

/** "Jun 1, 2026 – Jun 30, 2026" style period label for CSV/XLSX headers (device locale). */
export function periodLabel(fromMs: number, toMs: number): string {
  const from = new Date(fromMs);
  const lastDay = new Date(toMs - DAY_MS); // inclusive last day
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
  return `${from.toLocaleDateString(undefined, opts)} – ${lastDay.toLocaleDateString(undefined, opts)}`;
}
