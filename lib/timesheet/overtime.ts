// Overtime trimming for both timesheet views and every export.
//
// When a contract does not allow billing overtime, the billed total is cut to the
// weekly cap (weeklyHours) in whole rounding units, in two tiers:
//
//   1. The "(X)"-marked part of each line (`trimmableUnits`). A line can be
//      partly "(X)", so this is per line.
//   2. If that is not enough, the rest of each line, except its "(!)"-marked
//      part (`noTrimUnits`). "(!)" time is never cut but still counts toward
//      the cap. If "(!)" time alone exceeds the cap, the billed total stays
//      above it.
//
// Within a tier the cut is proportional to what each line can give (largest
// remainder), and a line can go to zero. Trimmed time is shown on a separate
// "Overtime" line.
//
// The Individual view trims each segment as one pool (`allocateOvertimeTrim`).
// The Summary view evens out the days (`allocateOvertimeTrimPerDay`): weekend
// days and holidays are billed in full, and working weekdays are water-filled
// toward a common ceiling.
//
// Holidays (see isTimeOffEntry in lib/calc) add no cap budget: the cap drops by
// weeklyHours / 5 per holiday.

import { monthSplitDay, type HolidaySet } from '../calc';

const NO_HOLIDAYS: HolidaySet = new Set<number>();

export interface TrimCell {
  units: number; // rounded duration, in whole rounding units
  trimmableUnits: number; // "(X)" share of units (0 ≤ this ≤ units)
  // "(!)" share of units, never removed. Disjoint from the trimmable share:
  // trimmableUnits + noTrimUnits ≤ units. Absent means 0.
  noTrimUnits?: number;
}

/** Units the trim may take from a cell: all but the "(!)" share. */
function flexibleUnits(c: TrimCell): number {
  return Math.max(0, c.units - (c.noTrimUnits ?? 0));
}

/**
 * Units to remove from each cell so the total drops to `capUnits`, aligned with
 * the input. "(!)" shares are never removed, so the total can stay above the cap.
 */
export function allocateOvertimeTrim(cells: TrimCell[], capUnits: number): number[] {
  const removed = new Array<number>(cells.length).fill(0);
  const total = cells.reduce((s, c) => s + c.units, 0);
  let excess = total - Math.max(0, capUnits);
  if (excess <= 0) return removed;

  // Tier 1: "(X)" shares. Tier 2: the rest, except "(!)" shares.
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
 * Like {@link allocateOvertimeTrim}, but evens out the working weekdays instead
 * of shrinking the segment proportionally. Weekend days (day < 2) and `holidays`
 * are billed in full. Working weekdays are water-filled to a common ceiling
 * near `(capUnits − non-working units) / workdays`; a short day lets the others
 * rise, so the total still reaches the cap. Each day's cut is split across its
 * cells with {@link allocateOvertimeTrim}. A day never keeps less than its "(!)"
 * units.
 *
 * If the non-working days alone exceed the cap (possible in a month-split
 * segment), workdays keep only their "(!)" units and the non-working days are
 * evened down toward the cap.
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
  // A day's "(!)" units: the least it can keep.
  const noTrimOf = (d: number) =>
    cells.reduce((s, c) => (c.day === d ? s + Math.min(c.noTrimUnits ?? 0, c.units) : s), 0);
  const offDays = days.filter((d) => d < 2 || holidays.has(d)); // weekend + holidays
  const workdays = days.filter((d) => d >= 2 && !holidays.has(d));
  const offUnits = offDays.reduce((s, d) => s + unitsOf(d), 0);

  // Units to keep per day, never below the day's "(!)" units.
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

  // Cut each day to its kept units, "(X)" first.
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
 * Water-fill: find the highest common ceiling such that the kept total stays
 * within `target`. Days below the ceiling keep everything, days above are cut
 * to it, and no day drops below its `floors` entry (its "(!)" units). With
 * `target ≤ Σfloors` only the floors are kept, which can exceed `target`.
 * Leftover units go to the largest days first. Returns kept units per day.
 */
function waterfillKeep(units: number[], target: number, floors?: number[]): number[] {
  const flo = units.map((u, i) => Math.min(Math.max(0, floors?.[i] ?? 0), u));
  const total = units.reduce((a, b) => a + b, 0);
  if (target >= total) return [...units];
  const floorSum = flo.reduce((a, b) => a + b, 0);
  if (target <= floorSum) return flo;

  // Binary search for the largest integer L with Σ max(floor, min(u, L)) ≤ target
  // (monotone in L).
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
  // Give the remainder to days still above the ceiling, largest first, so the
  // kept total reaches `target`.
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
 * Remove up to `excess` units, proportionally to `avail(cell, i)` (what each cell
 * can give in this tier). Returns the excess still outstanding.
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
 * Split `total` whole units across `weights` proportionally (largest remainder),
 * with each share capped at its weight. Requires `total <= sum(weights)`.
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
  // Hand out the rest by largest fraction, skipping cells at their cap. Loop in
  // case capped cells leave units for another pass.
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

/** Whole rounding units that fit under an hours cap (floored). */
export function capUnits(hours: number, roundingSeconds: number): number {
  if (hours <= 0 || roundingSeconds <= 0) return 0;
  return Math.floor((hours * 3600) / roundingSeconds);
}

/** One stretch of a week the overtime cap applies to, with its own unit budget. */
export interface WeekSegment {
  startDay: number; // inclusive, 0 = Sat … 6 = Fri
  endDay: number; // inclusive
  capUnits: number; // cap in whole rounding units
}

/**
 * Split a week into the segments the overtime cap applies to.
 *
 * Billing is per month, so a week containing the 1st is split there. Each
 * segment's cap is `weeklyHours / 5 × its working weekdays` (Mon–Fri minus
 * `holidays`); a 40h week with one holiday caps at 32h. A weekend-only segment
 * (the 1st on a Monday) caps at zero, so all but its "(!)" time is trimmed.
 */
export function weekSegments(
  weekStart: number,
  weeklyHours: number,
  roundingSeconds: number,
  holidays: HolidaySet = NO_HOLIDAYS
): WeekSegment[] {
  // Mon–Fri are indices 2…6. Weekends and holidays add nothing.
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
