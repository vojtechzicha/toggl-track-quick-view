// Builder for the Summary timesheet. The on-screen view and the exporters both
// call it, so exports show the same figures as the screen.

import {
  addDays,
  holidayDaysOfWeek,
  isTimeOffEntry,
  parseBillingCode,
  roundQuartersPreservingTotal,
  weekDayIndex,
  type TimeEntry,
} from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { allocateOvertimeTrimPerDay, weekSegments } from './overtime';
import {
  addToMappedAgg,
  entryBilling,
  finalizeMappedWeek,
  mappedRowKey,
  mappingFor,
  newMappedAgg,
  type CodeMapping,
  type MappedAgg,
} from './mapping';
import { fitDescs } from './desc';
import { UNTAGGED, MULTIPLE, projectBillingCode } from './constants';

export interface Cell {
  descs: string[]; // distinct (case-insensitive), in first-seen order
  // Display and copy text: `descs` joined with "; ". Billable cells are fitted to
  // the length limit (lib/timesheet/desc); warning cells are not, because their
  // text identifies the entries to fix.
  desc: string;
  // True when the limit dropped or cut something. `descs` keeps every part.
  descTruncated: boolean;
  seconds: number;
  trimmableSeconds: number; // "(X)" share of `seconds`
  noTrimSeconds: number; // "(!)" share of `seconds`, never trimmed
}

// Metadata for a normal (project, billing code) row.
export interface RowMeta {
  projectId: number;
  projectName: string;
  tag: string; // displayed billing code, markers stripped
}

export interface SummaryGrid {
  /** Day indices (0=Sat … 6=Fri) that have a column, in order. */
  dayCols: number[];
  /** Row keys in display order (tag rows first, then warning sentinels). */
  rows: string[];
  /** Per-row metadata for the normal (non-warning) rows. */
  rowMeta: Map<string, RowMeta>;
  /** Raw merged cells, keyed `${dayIdx}|${rowKey}` (pre-rounding seconds + descs). */
  cells: Map<string, Cell>;
  /** Rounded seconds per cell, keyed `${dayIdx}|${rowKey}`. */
  rounded: Map<string, number>;
  /** Rounded total per day column, aligned with `dayCols`. */
  dayTotals: number[];
  /** Rounded total per row, aligned with `rows`. */
  rowTotals: number[];
  /** Rounded billed total for the week, after any overtime trim. */
  grandTotal: number;
  /** Seconds trimmed by the overtime cap per day index (0=Sat … 6=Fri). */
  overtimeByDay: number[];
  /** Seconds trimmed by the overtime cap this week. */
  overtimeTotal: number;
  /** Holiday day indices (0=Sat … 6=Fri) this week. */
  holidays: Set<number>;
}

export interface SummaryInput {
  entries: TimeEntry[];
  weekStart: number;
  nowMs: number;
  projects: SelectedProject[];
  billingTagPrefix: string;
  // Rounding unit in seconds (e.g. 900 = 15 min, 720 = 12 min).
  roundingSeconds: number;
  // Character limit for each billable cell's description. null or absent means
  // no limit.
  maxDescriptionLength?: number | null;
  // When true, the billed total is trimmed to `weeklyHours` and the trimmed
  // time is reported separately. When false, `weeklyHours` is unused.
  noOvertime: boolean;
  weeklyHours: number;
  // Tag marking a time-off entry (see isTimeOffEntry). Empty or absent means
  // the default.
  timeOffTag?: string;
  // Projects that bill as one fixed row per day (see lib/timesheet/mapping).
  codeMappings?: CodeMapping[];
  // Drop parenthetical groups from codes ("D123 (Phase 2)" → "D123"), after the
  // markers are read. Codes that differ only there share a row.
  stripCodeParens?: boolean;
  // Bill every entry to its project, named by the row. Billing codes, support
  // tickets, markers, the parentheses strip and linked codes do not apply.
  billByProject?: boolean;
}

/**
 * Build the Summary grid for one week: days (columns) × rows. A row is a
 * (project, billing code) pair, so the same code under two projects gives two
 * rows. A cell sums one row's entries for one day and merges their
 * descriptions. Each day's cells are rounded so they add up to the day's
 * rounded total.
 *
 * Returns null when weekStart is falsy.
 */
export function buildSummaryGrid({
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
}: SummaryInput): SummaryGrid | null {
  if (!weekStart) return null;
  const ids = new Set(projects.map((p) => p.id));
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const weekEnd = addDays(weekStart, 7);

  const holidays = holidayDaysOfWeek(entries, ids, weekStart, timeOffTag);

  const cells = new Map<string, Cell>(); // key: `${dayIdx}|${rowKey}`
  const rowMeta = new Map<string, RowMeta>(); // rowKey -> meta (normal rows only)
  const dayHasEntries = new Array(7).fill(false);
  let untaggedPresent = false;
  let multiplePresent = false;

  // Mapped rows get a fixed value from finalizeMappedWeek and are excluded from
  // this sheet's rounding and trimming (see lib/timesheet/mapping).
  const mappedAggs = new Map<string, Map<number, MappedAgg>>(); // rowKey -> day -> agg
  const mappingByRow = new Map<string, CodeMapping>(); // rowKey -> its mapping
  const mappedRows = new Set<string>();

  const addDesc = (cell: Cell, desc: string) => {
    const text = desc.trim();
    if (!text) return;
    if (cell.descs.some((d) => d.toLowerCase() === text.toLowerCase())) return;
    cell.descs.push(text);
  };

  for (const e of entries) {
    if (e.project_id == null || !ids.has(e.project_id)) continue;
    const startMs = new Date(e.start).getTime();
    if (!Number.isFinite(startMs) || startMs < weekStart || startMs >= weekEnd) continue;
    const dayIdx = weekDayIndex(new Date(startMs));
    // Time-off markers only mark the day; they are never billed or shown.
    if (isTimeOffEntry(e.tags, timeOffTag)) continue;

    const running = e.duration < 0 || !e.stop;
    const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
    const seconds = Math.max(0, (stopMs - startMs) / 1000);

    // Row: (project, billing code), or a warning row for none or several codes.
    // A mapped project's tags use the mapping's prefix. With billByProject the
    // project name is the only "tag" and the description is used as is.
    const mapping = billByProject ? undefined : mappingFor(codeMappings, e.project_id);
    const { tags, description } = billByProject
      ? {
          tags: [projectBillingCode(nameById.get(e.project_id), e.project_id)],
          description: e.description ?? '',
        }
      : entryBilling(e.tags, e.description, mapping, billingTagPrefix);
    let rowKey: string;
    if (tags.length === 0) {
      rowKey = UNTAGGED;
      untaggedPresent = true;
    } else if (tags.length > 1) {
      rowKey = MULTIPLE;
      multiplePresent = true;
    } else if (mapping) {
      // Linked code: one row for the project, rounded after the loop.
      rowKey = mappedRowKey(e.project_id);
      mappedRows.add(rowKey);
      mappingByRow.set(rowKey, mapping);
      if (!rowMeta.has(rowKey)) {
        rowMeta.set(rowKey, {
          projectId: e.project_id,
          projectName: nameById.get(e.project_id) ?? '',
          tag: mapping.targetCode,
        });
      }
      dayHasEntries[dayIdx] = true;
      let byDay = mappedAggs.get(rowKey);
      if (!byDay) {
        byDay = new Map();
        mappedAggs.set(rowKey, byDay);
      }
      let agg = byDay.get(dayIdx);
      if (!agg) {
        agg = newMappedAgg(startMs);
        byDay.set(dayIdx, agg);
      }
      addToMappedAgg(agg, tags[0], seconds, description, startMs);
      continue;
    } else {
      // Marked codes share a row with their plain base. A project name is never
      // parsed, so a name ending in "(X)" is not a marker.
      const base = billByProject ? tags[0] : parseBillingCode(tags[0], stripCodeParens).base;
      rowKey = `p${e.project_id}|${base}`;
      if (!rowMeta.has(rowKey)) {
        rowMeta.set(rowKey, {
          projectId: e.project_id,
          projectName: nameById.get(e.project_id) ?? '',
          tag: base,
        });
      }
    }
    dayHasEntries[dayIdx] = true;

    const key = `${dayIdx}|${rowKey}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { descs: [], desc: '', descTruncated: false, seconds: 0, trimmableSeconds: 0, noTrimSeconds: 0 };
      cells.set(key, cell);
    }
    cell.seconds += seconds;
    if (!billByProject && rowKey !== UNTAGGED && rowKey !== MULTIPLE) {
      const { trimmable, neverTrim } = parseBillingCode(tags[0]);
      if (trimmable) cell.trimmableSeconds += seconds;
      if (neverTrim) cell.noTrimSeconds += seconds;
    }
    addDesc(cell, description);
  }

  // Columns: Mon–Fri (2–6) always; Sat/Sun (0–1) only when they have entries.
  const dayCols: number[] = [];
  for (let i = 0; i < 7; i++) {
    if (i >= 2 || dayHasEntries[i]) dayCols.push(i);
  }

  // Each mapped (project, day) becomes a fixed cell equal to the sub-client
  // sheet's billed day total.
  const mappedFixed = new Map<string, number>(); // key: `${dayIdx}|${rowKey}`
  for (const [rowKey, byDay] of mappedAggs) {
    const values = finalizeMappedWeek(byDay, mappingByRow.get(rowKey)!, weekStart, holidays);
    for (const [day, value] of values) {
      mappedFixed.set(`${day}|${rowKey}`, value.seconds);
      cells.set(`${day}|${rowKey}`, {
        descs: value.descs,
        desc: '',
        descTruncated: false,
        seconds: byDay.get(day)!.seconds,
        trimmableSeconds: 0,
        noTrimSeconds: 0,
      });
    }
  }

  // Rows: by project name, then code, then the warning rows.
  const tagRows = [...rowMeta.keys()].sort((a, b) => {
    const ma = rowMeta.get(a)!;
    const mb = rowMeta.get(b)!;
    return ma.projectName.localeCompare(mb.projectName) || ma.tag.localeCompare(mb.tag);
  });
  const rows = [...tagRows];
  if (multiplePresent) rows.push(MULTIPLE);
  if (untaggedPresent) rows.push(UNTAGGED);

  // Round each day's cells so they add up to the day's rounded total; totals are
  // summed from rounded cells. Mapped rows keep their fixed value: re-rounding
  // would break equality with the sub-client's sheet.
  const roundableRows = rows.filter((r) => !mappedRows.has(r));
  const rounded = new Map<string, number>(); // key: `${dayIdx}|${rowKey}`
  for (const d of dayCols) {
    const raw = roundableRows.map((r) => cells.get(`${d}|${r}`)?.seconds ?? 0);
    const adj = roundQuartersPreservingTotal(raw, { unitSeconds: roundingSeconds });
    roundableRows.forEach((r, ri) => rounded.set(`${d}|${r}`, adj[ri]));
    for (const r of mappedRows) rounded.set(`${d}|${r}`, mappedFixed.get(`${d}|${r}`) ?? 0);
  }

  // Overtime cap, per segment (see lib/timesheet/overtime). Warning rows are not
  // billed and are ignored. Mapped rows count toward the cap but are never cut.
  const overtimeByDay = new Array<number>(7).fill(0);
  if (noOvertime && weeklyHours > 0) {
    for (const seg of weekSegments(weekStart, weeklyHours, roundingSeconds, holidays)) {
      const billCells: {
        key: string;
        day: number;
        units: number;
        trimmableUnits: number;
        noTrimUnits: number;
      }[] = [];
      let mappedUnits = 0;
      for (const d of dayCols) {
        if (d < seg.startDay || d > seg.endDay) continue;
        for (const r of tagRows) {
          const units = Math.round((rounded.get(`${d}|${r}`) ?? 0) / roundingSeconds);
          if (units <= 0) continue;
          if (mappedRows.has(r)) {
            mappedUnits += units;
            continue;
          }
          const cell = cells.get(`${d}|${r}`);
          // "(X)" and "(!)" shares of the rounded units, kept disjoint.
          const frac = cell && cell.seconds > 0 ? cell.trimmableSeconds / cell.seconds : 0;
          const trimmableUnits = Math.min(units, Math.round(units * frac));
          const fracKeep = cell && cell.seconds > 0 ? cell.noTrimSeconds / cell.seconds : 0;
          const noTrimUnits = Math.min(units - trimmableUnits, Math.round(units * fracKeep));
          billCells.push({ key: `${d}|${r}`, day: d, units, trimmableUnits, noTrimUnits });
        }
      }
      const removed = allocateOvertimeTrimPerDay(
        billCells.map((c) => ({
          units: c.units,
          trimmableUnits: c.trimmableUnits,
          noTrimUnits: c.noTrimUnits,
          day: c.day,
        })),
        Math.max(0, seg.capUnits - mappedUnits),
        holidays
      );
      billCells.forEach((c, i) => {
        if (removed[i] > 0) {
          const strip = removed[i] * roundingSeconds;
          rounded.set(c.key, (rounded.get(c.key) ?? 0) - strip);
          overtimeByDay[c.day] += strip;
        }
      });
    }
  }

  // Day and grand totals exclude warning rows, matching the export, which omits
  // them. Row totals include every row so the view can show warning hours.
  const dayTotals = dayCols.map((d) =>
    tagRows.reduce((s, r) => s + (rounded.get(`${d}|${r}`) ?? 0), 0)
  );
  const rowTotals = rows.map((r) =>
    dayCols.reduce((s, d) => s + (rounded.get(`${d}|${r}`) ?? 0), 0)
  );
  const grandTotal = dayTotals.reduce((s, v) => s + v, 0);
  const overtimeTotal = overtimeByDay.reduce((s, v) => s + v, 0);

  // Fit billable descriptions to the length limit. Warning cells keep the full
  // text.
  for (const [key, cell] of cells) {
    const rowKey = key.slice(key.indexOf('|') + 1);
    const warn = rowKey === UNTAGGED || rowKey === MULTIPLE;
    const fitted = fitDescs(cell.descs, warn ? null : maxDescriptionLength);
    cell.desc = fitted.text;
    cell.descTruncated = fitted.truncated;
  }

  return {
    dayCols,
    rows,
    rowMeta,
    cells,
    rounded,
    dayTotals,
    rowTotals,
    grandTotal,
    overtimeByDay,
    overtimeTotal,
    holidays,
  };
}
