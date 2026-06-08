// Pure builder for the Individual timesheet view. Shared by the on-screen
// IndividualTimesheet component and the exporters so they show identical figures
// (same same-code combining, same biased quarter-hour rounding, same time anchoring).

import {
  billingTagsOf,
  fmtHoursLabel,
  fmtTimeOfDay,
  roundQuartersPreservingTotal,
  QUARTER_SECONDS,
  type TimeEntry,
} from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { DAY_MS, UNTAGGED, MULTIPLE, TOOLONG } from './constants';

const QUARTER_MS = QUARTER_SECONDS * 1000;
const COMBINE_GAP_SECONDS = 60 * 60; // combine same-code entries only within this gap
const OVERLAP_MIN_MS = 60 * 1000; // ignore sub-minute touches (display/manual-entry noise)

/** A raw selected-project entry for one day, normalised to ms bounds. */
interface DayEntry {
  startMs: number;
  stopMs: number;
  seconds: number;
  projId: number | null;
  tags?: string[];
  desc: string;
}

export type WarnKind = typeof UNTAGGED | typeof MULTIPLE | typeof TOOLONG;

/** One rendered line: a billable entry (with a time span) or a warning aggregate. */
export interface Row {
  key: string;
  kind: 'bill' | 'warn';
  warn?: WarnKind;
  code?: string; // billing tag, for 'bill' rows
  projId?: number | null; // owning project, for 'bill' rows
  seconds: number; // raw, pre-rounding
  rounded: number; // filled in after rounding
  startMs?: number; // anchored display start (bill rows, after rounding)
  endMs?: number; // start + rounded duration
  descs: string[];
  groupStartMs: number; // first raw start, used to anchor the display time
}

export interface IndividualDay {
  dayIdx: number;
  dateMs: number;
  rows: Row[];
  total: number;
  overlaps: string[];
}

export interface IndividualWeek {
  days: IndividualDay[];
  grandTotal: number;
}

export interface IndividualInput {
  entries: TimeEntry[];
  weekStart: number;
  nowMs: number;
  projects: SelectedProject[];
  maxBillableHours: number;
  billingTagPrefix: string;
}

export function warnLabel(kind: WarnKind, maxBillableHours: number): string {
  switch (kind) {
    case UNTAGGED:
      return 'No billing tag';
    case MULTIPLE:
      return 'Multiple billing tags';
    case TOOLONG:
      return `Too long to bill individually (> ${fmtHoursLabel(maxBillableHours)})`;
  }
}

function mergeDesc(into: string[], desc: string) {
  const text = desc.trim();
  if (!text) return;
  if (into.some((d) => d.toLowerCase() === text.toLowerCase())) return;
  into.push(text);
}

/** Snap an absolute time to the nearest 15-minute clock mark. */
function snapQuarter(ms: number): number {
  return Math.round(ms / QUARTER_MS) * QUARTER_MS;
}

/**
 * Build one day's rows from its selected-project entries.
 *
 * Entries are classified, then consecutive same-code entries are combined while
 * the gap stays within an hour and the combined duration stays billable (within
 * the cap). Durations are rounded to 15-minute units preserving the day total
 * (biased so a tiny entry surfaces rather than vanishing; a billable line still
 * at zero is dropped). Finally each billable line's start is snapped to the
 * nearest quarter and packed forward so the displayed blocks never overlap.
 */
export function buildDay(
  dayEntries: DayEntry[],
  maxBillableSeconds: number,
  billingTagPrefix: string
) {
  const sorted = [...dayEntries].sort((a, b) => a.startMs - b.startMs);

  // Overlaps in the raw data (you can't bill two entries running at once). Sorted
  // by start, so once a later entry begins at/after this one's stop, nothing
  // further can overlap it.
  const overlaps: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startMs >= sorted[i].stopMs) break;
      // Entries that merely touch (or overlap by seconds, which the minute-level
      // display can't even show) aren't worth flagging — only a real overlap is.
      const overlapMs = Math.min(sorted[i].stopMs, sorted[j].stopMs) - sorted[j].startMs;
      if (overlapMs < OVERLAP_MIN_MS) continue;
      overlaps.push(
        `${fmtTimeOfDay(sorted[i].startMs)}–${fmtTimeOfDay(sorted[i].stopMs)} ⨯ ` +
          `${fmtTimeOfDay(sorted[j].startMs)}–${fmtTimeOfDay(sorted[j].stopMs)}`
      );
    }
  }

  const bill: Row[] = [];
  const warnBuckets: Record<WarnKind, Row | null> = {
    [UNTAGGED]: null,
    [MULTIPLE]: null,
    [TOOLONG]: null,
  };
  const addWarn = (kind: WarnKind, e: DayEntry) => {
    let row = warnBuckets[kind];
    if (!row) {
      row = { key: kind, kind: 'warn', warn: kind, seconds: 0, rounded: 0, descs: [], groupStartMs: e.startMs };
      warnBuckets[kind] = row;
    }
    row.seconds += e.seconds;
    mergeDesc(row.descs, e.desc);
  };

  let current: Row | null = null; // open billable group being combined into
  let lastStopMs = 0; // stop of the last entry merged into `current`
  const flush = () => {
    current = null;
  };

  for (const e of sorted) {
    const tags = billingTagsOf(e.tags, billingTagPrefix);
    if (tags.length === 0) {
      flush();
      addWarn(UNTAGGED, e);
      continue;
    }
    if (tags.length > 1) {
      flush();
      addWarn(MULTIPLE, e);
      continue;
    }
    if (e.seconds > maxBillableSeconds) {
      flush();
      addWarn(TOOLONG, e); // a single oversize entry can't be split
      continue;
    }

    const code = tags[0];
    // Same billing tag under two different projects stays separate: a project is a
    // group of billing tags, so they're distinct lines even with an identical code.
    const canCombine =
      current !== null &&
      current.code === code &&
      current.projId === e.projId &&
      e.startMs - lastStopMs <= COMBINE_GAP_SECONDS * 1000 &&
      current.seconds + e.seconds <= maxBillableSeconds;

    if (canCombine && current) {
      current.seconds += e.seconds;
      mergeDesc(current.descs, e.desc);
    } else {
      current = {
        key: `b${e.startMs}`,
        kind: 'bill',
        code,
        projId: e.projId,
        seconds: e.seconds,
        rounded: 0,
        descs: [],
        groupStartMs: e.startMs,
      };
      mergeDesc(current.descs, e.desc);
      bill.push(current);
    }
    lastStopMs = e.stopMs;
  }

  // Rows that take part in the day's rounding: billable lines first, then any
  // warning aggregates. Bias the spare quarters toward would-be-zero entries so
  // small entries surface (a billable line still at zero is then dropped).
  const warnRows = ([UNTAGGED, MULTIPLE, TOOLONG] as WarnKind[])
    .map((k) => warnBuckets[k])
    .filter((r): r is Row => r !== null);
  const allRows = [...bill, ...warnRows];
  const rounded = roundQuartersPreservingTotal(
    allRows.map((r) => r.seconds),
    { biasZero: true }
  );
  allRows.forEach((r, i) => (r.rounded = rounded[i]));

  // Drop billable lines that still round to nothing; warning rows always stay so
  // the tag/length problem keeps surfacing even when its time is negligible.
  const billKept = bill.filter((r) => r.rounded > 0);

  // Anchor each billable line's start to the nearest quarter and pack forward so
  // the displayed blocks never overlap, even after rounding. The end is the
  // start plus the rounded duration.
  let cursor = -Infinity;
  for (const r of billKept) {
    let start = snapQuarter(r.groupStartMs);
    if (start < cursor) start = cursor;
    const end = start + r.rounded * 1000;
    r.startMs = start;
    r.endMs = end;
    cursor = end;
  }

  const rows = [...billKept, ...warnRows];
  const total = allRows.reduce((s, r) => s + r.rounded, 0);
  return { rows, total, overlaps };
}

/**
 * Build the Individual view for one week: a list of days, each listing its
 * selected-project entries on their own rows with start–end time, rounded hours and
 * description. Returns null when there's no week to build (weekStart falsy).
 */
export function buildIndividualWeek({
  entries,
  weekStart,
  nowMs,
  projects,
  maxBillableHours,
  billingTagPrefix,
}: IndividualInput): IndividualWeek | null {
  if (!weekStart) return null;
  const ids = new Set(projects.map((p) => p.id));
  const maxBillableSeconds = maxBillableHours * 3600;
  const weekEnd = weekStart + 7 * DAY_MS;

  const byDay: DayEntry[][] = Array.from({ length: 7 }, () => []);
  for (const e of entries) {
    if (e.project_id == null || !ids.has(e.project_id)) continue;
    const startMs = new Date(e.start).getTime();
    if (!Number.isFinite(startMs) || startMs < weekStart || startMs >= weekEnd) continue;
    const dayIdx = Math.floor((startMs - weekStart) / DAY_MS);
    if (dayIdx < 0 || dayIdx > 6) continue;

    const running = e.duration < 0 || !e.stop;
    const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
    byDay[dayIdx].push({
      startMs,
      stopMs,
      seconds: Math.max(0, (stopMs - startMs) / 1000),
      projId: e.project_id,
      tags: e.tags,
      desc: e.description ?? '',
    });
  }

  const days = byDay
    .map((dayEntries, dayIdx) => ({
      dayIdx,
      dateMs: weekStart + dayIdx * DAY_MS,
      ...buildDay(dayEntries, maxBillableSeconds, billingTagPrefix),
    }))
    .filter((d) => d.rows.length > 0 || d.overlaps.length > 0);

  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  return { days, grandTotal };
}
