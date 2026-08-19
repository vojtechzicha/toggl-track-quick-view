// Date-range presets and helpers for the export dialog. A range is always a
// half-open [fromMs, toMs) interval in local time (toMs is the exclusive end, i.e.
// the midnight after the last included day). The on-screen views are week-based
// (Saturday-start), so a month export is rendered as the Saturday-weeks it spans —
// `weeksInRange` enumerates them.

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

/** Half-open day range [fromMs, toMs) — toMs is the midnight after the last day. */
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
 * Resolve a preset to a concrete [from, to) range.
 * `selectedWeekStart` anchors "selected week" (the week being viewed on the page);
 * it falls back to the current week when absent. "Selected month" and "custom" both
 * just seed the current month — the user then edits the from/to inputs directly.
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

/**
 * The Saturday-week starts (ms) whose 7-day span overlaps [fromMs, toMs), in order.
 * Each is a week the summary/individual builders can render. Empty when the range
 * is empty.
 */
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
 * Clip a preset-resolved range to the engagement's first billable day (the
 * workspace's stored `startDate`, `yyyy-mm-dd`; empty = no start date). A month
 * preset on a workspace that started Aug 16 then yields Aug 16–31 rather than a
 * document claiming the whole of August. Only the *from* edge moves, and only
 * forward. A range that lies entirely before the start date ("Last month" on an
 * engagement that began this month) collapses to the empty [start, start) —
 * never the original pre-engagement range, which would let a billing document
 * pick up work from before the engagement. The dialog's date inputs reject the
 * collapsed range, so such a preset cannot be exported. Callers apply this to
 * preset resolutions only — a hand-edited custom range is the user's own to set.
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
  const toMs = toDay + DAY_MS; // make the end exclusive (include the whole `to` day)
  if (!(toMs > fromMs)) return null;
  return { fromMs, toMs };
}
