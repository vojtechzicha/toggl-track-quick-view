// Date-range presets and helpers for the export dialog. A range is a half-open
// [fromMs, toMs) interval in local time; toMs is the midnight after the last
// included day. The views are built per Saturday-start week, so a month export
// is rendered as the weeks it overlaps (`weeksInRange`).

import { startOfDay, startOfWeek } from '@/lib/calc';
import { DAY_MS } from '@/lib/timesheet/constants';

export type ExportPreset =
  | 'current-week'
  | 'selected-week'
  | 'current-month'
  | 'last-month'
  | 'selected-month'
  | 'custom';

export const PRESET_LABELS: Record<ExportPreset, string> = {
  'current-week': 'Current week',
  'selected-week': 'Selected week',
  'current-month': 'Current month',
  'last-month': 'Last month',
  'selected-month': 'Selected month',
  custom: 'Custom range',
};

/** Half-open day range [fromMs, toMs); toMs is the midnight after the last day. */
export interface DateRange {
  fromMs: number;
  toMs: number;
}

const WEEK_MS = 7 * DAY_MS;

/** First instant (local midnight) of the month containing `d`. */
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

/** Local midnight on the first day of the month *after* the one containing `d`. */
export function startOfNextMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 1);
}

/**
 * Resolve a preset to a concrete range. `selectedWeekStart` is the week shown on
 * the page and anchors "selected week"; without it, the current week is used.
 * "Selected month" and "custom" seed the current month for the user to edit.
 */
export function resolvePreset(
  preset: ExportPreset,
  nowMs: number,
  selectedWeekStart: number | null
): DateRange {
  const now = new Date(nowMs);
  switch (preset) {
    case 'current-week': {
      const ws = startOfWeek(now).getTime();
      return { fromMs: ws, toMs: ws + WEEK_MS };
    }
    case 'selected-week': {
      const ws = selectedWeekStart ?? startOfWeek(now).getTime();
      return { fromMs: ws, toMs: ws + WEEK_MS };
    }
    case 'last-month': {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      return { fromMs: from.getTime(), toMs: startOfMonth(now).getTime() };
    }
    case 'current-month':
    case 'selected-month':
    case 'custom':
    default:
      return { fromMs: startOfMonth(now).getTime(), toMs: startOfNextMonth(now).getTime() };
  }
}

/** Start (ms) of each Saturday-start week that overlaps [fromMs, toMs), in order. */
export function weeksInRange(fromMs: number, toMs: number): number[] {
  if (!(toMs > fromMs)) return [];
  const first = startOfWeek(new Date(fromMs)).getTime();
  const weeks: number[] = [];
  for (let ws = first; ws < toMs; ws += WEEK_MS) weeks.push(ws);
  return weeks;
}

// ---- yyyy-mm-dd <-> ms helpers for the date inputs (parsed in local time) ----

/** Format a local ms timestamp as a `yyyy-mm-dd` string for an <input type=date>. */
export function toDateInput(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse a `yyyy-mm-dd` input to local midnight ms, or null when malformed. */
export function fromDateInput(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d.getTime()) ? startOfDay(d).getTime() : null;
}

/**
 * Clip a preset range to the engagement's first billable day (`startDate`,
 * `yyyy-mm-dd`; empty = none). A month preset on a workspace that started
 * Aug 16 yields Aug 16–31. Only the start moves, and only forward.
 *
 * A range entirely before the start date collapses to the empty
 * [start, start), never the original range, so a billing document cannot pick
 * up pre-engagement work. The dialog rejects the empty range. Apply this to
 * presets only; a hand-edited range is left as typed.
 */
export function clipRangeToStart(range: DateRange, startDate: string): DateRange {
  const startMs = startDate ? fromDateInput(startDate) : null;
  if (startMs == null || startMs <= range.fromMs) return range;
  return { fromMs: startMs, toMs: Math.max(startMs, range.toMs) };
}

/**
 * Range from the two date inputs (inclusive `from` day through inclusive `to` day).
 * Returns null when either is malformed or `to` precedes `from`.
 */
export function rangeFromInputs(fromStr: string, toStr: string): DateRange | null {
  const fromMs = fromDateInput(fromStr);
  const toDay = fromDateInput(toStr);
  if (fromMs == null || toDay == null) return null;
  const toMs = toDay + DAY_MS; // exclusive end: include the whole `to` day
  if (!(toMs > fromMs)) return null;
  return { fromMs, toMs };
}
