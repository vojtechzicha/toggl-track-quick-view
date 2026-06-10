// Pure builder for the Summary timesheet view. Both the on-screen SummaryTimesheet
// component and the exporters call this, so a CSV/XLSX/PDF export shows byte-identical
// figures to what's on screen (same per-day quarter-hour rounding, same grouping).

import { billingTagsOf, roundQuartersPreservingTotal, type TimeEntry } from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { DAY_MS, UNTAGGED, MULTIPLE } from './constants';

export interface Cell {
  descs: string[]; // de-duplicated, original-cased, in first-seen order
  seconds: number;
}

// A normal row is one (project, billing-tag) pair; warning rows are the sentinels.
export interface RowMeta {
  projectId: number;
  projectName: string;
  tag: string;
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
  /** Rounded grand total for the week. */
  grandTotal: number;
}

export interface SummaryInput {
  entries: TimeEntry[];
  weekStart: number;
  nowMs: number;
  projects: SelectedProject[];
  billingTagPrefix: string;
  // The rounding granularity in seconds (e.g. 900 = 15 min, 720 = 12 min).
  roundingSeconds: number;
}

/**
 * Build the Summary grid for one week: a grid of days (columns) × rows. A row is
 * normally a (project, billing-tag) pair — the same tag under two projects stays on
 * two separate rows. Each day's entries for a row are combined into one cell —
 * durations summed, descriptions merged without repeats — and rounded to the
 * configured unit so each day's cells still add up to that day's rounded total (no drift).
 *
 * Returns null when there's no week to build (weekStart falsy).
 */
export function buildSummaryGrid({
  entries,
  weekStart,
  nowMs,
  projects,
  billingTagPrefix,
  roundingSeconds,
}: SummaryInput): SummaryGrid | null {
  if (!weekStart) return null;
  const ids = new Set(projects.map((p) => p.id));
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const weekEnd = weekStart + 7 * DAY_MS;

  const cells = new Map<string, Cell>(); // key: `${dayIdx}|${rowKey}`
  const rowMeta = new Map<string, RowMeta>(); // rowKey -> meta (normal rows only)
  const dayHasEntries = new Array(7).fill(false);
  let untaggedPresent = false;
  let multiplePresent = false;

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
    const dayIdx = Math.floor((startMs - weekStart) / DAY_MS);
    if (dayIdx < 0 || dayIdx > 6) continue;

    const running = e.duration < 0 || !e.stop;
    const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
    const seconds = Math.max(0, (stopMs - startMs) / 1000);

    // Which row this entry lands in: its (project, single billing tag), or a
    // warning row when it has none / more than one (both need fixing in Toggl).
    const tags = billingTagsOf(e.tags, billingTagPrefix);
    let rowKey: string;
    if (tags.length === 0) {
      rowKey = UNTAGGED;
      untaggedPresent = true;
    } else if (tags.length > 1) {
      rowKey = MULTIPLE;
      multiplePresent = true;
    } else {
      rowKey = `p${e.project_id}|${tags[0]}`;
      if (!rowMeta.has(rowKey)) {
        rowMeta.set(rowKey, {
          projectId: e.project_id,
          projectName: nameById.get(e.project_id) ?? '',
          tag: tags[0],
        });
      }
    }
    dayHasEntries[dayIdx] = true;

    const key = `${dayIdx}|${rowKey}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { descs: [], seconds: 0 };
      cells.set(key, cell);
    }
    cell.seconds += seconds;
    addDesc(cell, e.description ?? '');
  }

  // Columns: Mon–Fri always; the leading Sat/Sun only when they have entries.
  // With a Saturday-start week those are indices 0–1, so weekdays are 2–6.
  const dayCols: number[] = [];
  for (let i = 0; i < 7; i++) {
    if (i >= 2 || dayHasEntries[i]) dayCols.push(i);
  }

  // Rows: normal rows grouped by project, then tag (both alphabetical), then the
  // warning rows (multiple, untagged) last.
  const tagRows = [...rowMeta.keys()].sort((a, b) => {
    const ma = rowMeta.get(a)!;
    const mb = rowMeta.get(b)!;
    return ma.projectName.localeCompare(mb.projectName) || ma.tag.localeCompare(mb.tag);
  });
  const rows = [...tagRows];
  if (multiplePresent) rows.push(MULTIPLE);
  if (untaggedPresent) rows.push(UNTAGGED);

  // Round to the configured units per day: each cell is rounded so the cells still
  // add up to the day's rounded total (no accumulated drift), with the rounding
  // error spread evenly across the rows. Totals are then summed from these rounded
  // cells, so every figure shown is a clean multiple of the rounding unit.
  const rounded = new Map<string, number>(); // key: `${dayIdx}|${rowKey}`
  for (const d of dayCols) {
    const raw = rows.map((r) => cells.get(`${d}|${r}`)?.seconds ?? 0);
    const adj = roundQuartersPreservingTotal(raw, { unitSeconds: roundingSeconds });
    rows.forEach((r, ri) => rounded.set(`${d}|${r}`, adj[ri]));
  }

  const dayTotals = dayCols.map((d) =>
    rows.reduce((s, r) => s + (rounded.get(`${d}|${r}`) ?? 0), 0)
  );
  const rowTotals = rows.map((r) =>
    dayCols.reduce((s, d) => s + (rounded.get(`${d}|${r}`) ?? 0), 0)
  );
  const grandTotal = rowTotals.reduce((s, v) => s + v, 0);

  return { dayCols, rows, rowMeta, cells, rounded, dayTotals, rowTotals, grandTotal };
}
