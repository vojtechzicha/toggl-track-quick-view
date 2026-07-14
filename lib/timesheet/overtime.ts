// Overtime trimming, shared by both timesheet views (and so every export).
//
// When an engagement contractually disallows billing overtime, the timesheet must
// not report more than the weekly cap (weeklyHours) even though the extra time was
// genuinely tracked. This module decides how many whole rounding units to shave off
// the week's billable lines to bring the *billed* total down to the cap, in two
// tiers:
//
//   1. The "(X)"-marked portion of each line (its `trimmableUnits`) is shaved first
//      — that's the buffer the user explicitly flagged as disposable. A line can be
//      part trimmable (some of its time tagged "(X)", some not), so the budget is
//      per-line, not all-or-nothing.
//   2. Only if emptying every "(X)" portion still isn't enough, the firm remainder
//      of the lines is trimmed too — except any "(!)"-marked portion (a line's
//      `noTrimUnits`), which is NEVER touched: it always bills whole while still
//      consuming the cap, so the cut lands on the other lines instead. When the
//      protected time alone exceeds the cap the billed total stays above it — the
//      same precedent the fixed linked-code lines already set.
//
// Within each tier the cut is spread proportionally to each line's available size
// (the same largest-remainder / Hamilton method the rounding uses), so the reduction
// lands as evenly as possible across codes and days. A line may be reduced all the
// way to zero. The trimmed time is never billed — the views surface it on a separate
// "Overtime" line so it stays visible.
//
// The Individual view trims a segment as one pool with `allocateOvertimeTrim`, so a
// busy day stays proportionally busy. The Summary view instead evens out the *days*
// with `allocateOvertimeTrimPerDay`: the non-working days (weekend + holidays) are
// billed in full and the working weekdays are water-filled toward a common
// (weekTarget − non-working)/workdays ceiling — same per-day, trimmable-first cut
// underneath, just distributed to flatten the week.
//
// Holidays (days marked by a time-off entry, see isTimeOffEntry in lib/calc) are
// non-working days exactly like the weekend: they contribute no cap budget (the
// weekly cap drops by weeklyHours/5 per holiday) and any work actually tracked on
// them is billed in full on top, never water-filled down.

import { monthSplitDay, type HolidaySet } from '../calc';

const NO_HOLIDAYS: HolidaySet = new Set<number>();

export interface TrimCell {
  units: number; // current rounded duration, in whole rounding units
  trimmableUnits: number; // the "(X)"-marked portion of those units (0 ≤ this ≤ units)
  // The "(!)"-marked portion of those units — never removed. Disjoint from the
  // trimmable share; trimmableUnits + noTrimUnits ≤ units. Absent = 0.
  noTrimUnits?: number;
}

/** The units of a cell the trim may still take (everything but the "(!)" share). */
function flexibleUnits(c: TrimCell): number {
  return Math.max(0, c.units - (c.noTrimUnits ?? 0));
}

/**
 * Whole rounding units to remove from each cell so the billable total drops to
 * `capUnits`. Returns an array aligned with the input (0 = untouched). When already
 * at or under the cap, nothing is removed. "(!)"-marked portions are never removed,
 * so when the protected time alone exceeds the cap the result under-trims — the
 * billed total then stays above the cap by exactly that protected excess.
 */
export function allocateOvertimeTrim(cells: TrimCell[], capUnits: number): number[] {
  const removed = new Array<number>(cells.length).fill(0);
  const total = cells.reduce((s, c) => s + c.units, 0);
  let excess = total - Math.max(0, capUnits);
  if (excess <= 0) return removed;

  // Tier 1: each line's trimmable "(X)" portion. Tier 2: whatever firm time is
  // left, never touching the protected "(!)" share.
  excess = trimTier(cells, removed, excess, (c, i) =>
    Math.max(0, Math.min(c.trimmableUnits, flexibleUnits(c)) - removed[i])
  );
  trimTier(cells, removed, excess, (c, i) => flexibleUnits(c) - removed[i]);
  return removed;
}

/** A trim cell tagged with the week day it falls on (0 = Sat … 6 = Fri). */
export interface DayTrimCell extends TrimCell {
  day: number;
}

/**
 * Like {@link allocateOvertimeTrim}, but instead of shrinking the whole segment
 * proportionally it evens out the *working weekdays*. The non-working days — the
 * weekend (Sat/Sun, day < 2) plus any `holidays` — are kept billed in full and the
 * working weekdays are water-filled down to a common ceiling so each lands as close
 * as possible to `(capUnits − non-working) / workdays`, while the segment total
 * still drops to `capUnits`. When every workday sits above the line the ceiling is
 * exactly that per-day target; when one is short the others float up to absorb the
 * slack, so the week still hits the cap rather than billing under it.
 *
 * The per-day reduction is shared across that day's own cells with the same
 * trimmable-"(X)"-first apportionment as `allocateOvertimeTrim`. Returns removals
 * aligned with the input (0 = untouched). When already under the cap, nothing moves.
 *
 * Every day's kept total is floored at its protected "(!)" units — that share is
 * never removed, even when it means the billed total stays above the cap.
 *
 * Degenerate case: when the non-working days alone exceed `capUnits` (rare —
 * month-split segments cap below a full week), the workdays drop to their
 * protected floor and the non-working days are evened down toward the cap.
 */
export function allocateOvertimeTrimPerDay(
  cells: DayTrimCell[],
  capUnits: number,
  holidays: HolidaySet = NO_HOLIDAYS
): number[] {
  const removed = new Array<number>(cells.length).fill(0);
  const cap = Math.max(0, capUnits);
  const total = cells.reduce((s, c) => s + c.units, 0);
  if (total <= cap) return removed;

  const days = [...new Set(cells.map((c) => c.day))];
  const unitsOf = (d: number) =>
    cells.reduce((s, c) => (c.day === d ? s + c.units : s), 0);
  // A day's protected "(!)" units — the floor its kept total can never drop below.
  const noTrimOf = (d: number) =>
    cells.reduce((s, c) => (c.day === d ? s + Math.min(c.noTrimUnits ?? 0, c.units) : s), 0);
  const offDays = days.filter((d) => d < 2 || holidays.has(d)); // weekend + holidays
  const workdays = days.filter((d) => d >= 2 && !holidays.has(d));
  const offUnits = offDays.reduce((s, d) => s + unitsOf(d), 0);

  // Per-day units to keep. Normally the non-working days ride along whole and the
  // workdays are water-filled into whatever the cap leaves; if the non-working days
  // alone blow the cap, the workdays keep only their protected floor and the
  // non-working days are evened down to the cap instead. Every day's kept total is
  // floored at its protected "(!)" units, so the within-day cut below never has to
  // reach into them (the billed total may then exceed the cap — by design).
  const keepByDay = new Map<number, number>();
  const budget = cap - offUnits;
  if (budget >= 0) {
    offDays.forEach((d) => keepByDay.set(d, unitsOf(d)));
    const keep = waterfillKeep(workdays.map(unitsOf), budget, workdays.map(noTrimOf));
    workdays.forEach((d, i) => keepByDay.set(d, keep[i]));
  } else {
    workdays.forEach((d) => keepByDay.set(d, noTrimOf(d)));
    const keep = waterfillKeep(offDays.map(unitsOf), cap, offDays.map(noTrimOf));
    offDays.forEach((d, i) => keepByDay.set(d, keep[i]));
  }

  // Reduce each day to its kept budget, trimmable "(X)" first, within that day alone.
  for (const d of days) {
    const idx = cells.map((_, i) => i).filter((i) => cells[i].day === d);
    const sub = allocateOvertimeTrim(
      idx.map((i) => cells[i]),
      keepByDay.get(d) ?? unitsOf(d)
    );
    idx.forEach((i, k) => (removed[i] = sub[k]));
  }
  return removed;
}

/**
 * Water-fill: keep as much of each day's `units` as a single common ceiling allows
 * without the kept total exceeding `target`, raising the ceiling until the total is
 * met. Days below the ceiling keep everything; days above are levelled to it. Each
 * day's kept units never drop below its `floors` entry (the protected "(!)" share)
 * — a day whose floor sits above the ceiling simply keeps its floor. Returns kept
 * units per day. With `target ≥ sum` nothing is trimmed; with `target ≤ Σfloors`
 * only the floors survive (the kept total may then exceed `target` — protected
 * time is never cut). The few units that don't divide evenly land on the largest
 * days first.
 */
function waterfillKeep(units: number[], target: number, floors?: number[]): number[] {
  const flo = units.map((u, i) => Math.min(Math.max(0, floors?.[i] ?? 0), u));
  const total = units.reduce((a, b) => a + b, 0);
  if (target >= total) return [...units];
  const floorSum = flo.reduce((a, b) => a + b, 0);
  if (target <= floorSum) return flo;

  // Largest integer ceiling L with Σ max(floor, min(u, L)) ≤ target (binary search
  // the staircase — still monotone in L with the floors in place).
  const keptAt = (level: number) =>
    units.reduce((a, u, i) => a + Math.max(flo[i], Math.min(u, level)), 0);
  let lo = 0;
  let hi = Math.max(...units);
  let level = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (keptAt(mid) <= target) {
      level = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const keep = units.map((u, i) => Math.max(flo[i], Math.min(u, level)));
  // Hand the remainder to the days still above the ceiling, largest first, so the
  // kept total reaches `target` exactly while staying as level as the integers allow.
  let leftover = target - keep.reduce((a, b) => a + b, 0);
  const order = units
    .map((u, i) => ({ i, head: u - keep[i] }))
    .filter((x) => x.head > 0)
    .sort((a, b) => b.head - a.head || a.i - b.i);
  for (const { i } of order) {
    if (leftover <= 0) break;
    keep[i] += 1;
    leftover -= 1;
  }
  return keep;
}

/**
 * Shave up to `excess` units off the cells, where `avail(cell, i)` is how much each
 * cell may still give up in this tier. The cut is apportioned proportionally to the
 * available amounts. Returns the excess still outstanding after the tier.
 */
function trimTier(
  cells: TrimCell[],
  removed: number[],
  excess: number,
  avail: (c: TrimCell, i: number) => number
): number {
  if (excess <= 0) return 0;
  const idx = cells.map((_, i) => i).filter((i) => avail(cells[i], i) > 0);
  const caps = idx.map((i) => avail(cells[i], i));
  const take = Math.min(excess, caps.reduce((a, b) => a + b, 0));
  if (take <= 0) return excess;
  const alloc = apportion(take, caps);
  idx.forEach((i, k) => (removed[i] += alloc[k]));
  return excess - take;
}

/**
 * Distribute `total` whole units across `weights` proportionally to each weight,
 * giving the leftover units to the largest fractional remainders (Hamilton), with
 * every allocation capped at its own weight. Requires `total <= sum(weights)`.
 */
function apportion(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const ideal = weights.map((w) => (total * w) / sum);
  const out = ideal.map((x) => Math.floor(x));
  let rem = total - out.reduce((a, b) => a + b, 0);
  const order = ideal
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  // Hand out the remaining units by largest fractional part, skipping any cell
  // already at its cap; loop in case caps push leftovers onto later passes.
  while (rem > 0) {
    let progressed = false;
    for (let k = 0; k < order.length && rem > 0; k++) {
      const i = order[k].i;
      if (out[i] < weights[i]) {
        out[i] += 1;
        rem -= 1;
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}

/** Whole rounding units that fit under an hours cap (floored, so never over). */
export function capUnits(hours: number, roundingSeconds: number): number {
  if (hours <= 0 || roundingSeconds <= 0) return 0;
  return Math.floor((hours * 3600) / roundingSeconds);
}

/** One stretch of a week the overtime cap applies to, with its own unit budget. */
export interface WeekSegment {
  startDay: number; // inclusive day index within the week (0 = Sat … 6 = Fri)
  endDay: number; // inclusive
  capUnits: number; // overtime cap for this segment, in whole rounding units
}

/**
 * Split a week into the segments the overtime cap applies to.
 *
 * Billing runs to month-end, so when a month boundary falls mid-week the week is
 * cut there and each side gets its own cap, proportional to the number of working
 * weekdays (Mon–Fri, minus `holidays`) it contains: `weeklyHours / 5 × that count`.
 * A holiday therefore drops the cap by a day's worth — a 40h week with one state
 * holiday caps at 32h. A weekend-only segment caps at zero — its work isn't billed
 * — e.g. when the 1st lands on a Monday the leading Sat–Sun is capped at nothing.
 * A week wholly inside one month is a single full-week segment, exactly as before.
 */
export function weekSegments(
  weekStart: number,
  weeklyHours: number,
  roundingSeconds: number,
  holidays: HolidaySet = NO_HOLIDAYS
): WeekSegment[] {
  // Mon–Fri are day indices 2…6; Sat/Sun (0,1) are weekend and add nothing —
  // and neither does a weekday marked as a holiday.
  const segHours = (start: number, end: number) => {
    let weekdays = 0;
    for (let d = start; d <= end; d++) if (d >= 2 && !holidays.has(d)) weekdays++;
    return (weeklyHours / 5) * weekdays;
  };
  const seg = (start: number, end: number): WeekSegment => ({
    startDay: start,
    endDay: end,
    capUnits: capUnits(segHours(start, end), roundingSeconds),
  });

  const split = monthSplitDay(weekStart);
  return split === null ? [seg(0, 6)] : [seg(0, split - 1), seg(split, 6)];
}
