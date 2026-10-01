// Balancing working days, for both timesheet views and every export.
//
// Some engagements want every working day on the timesheet at the daily target
// (weeklyHours / 5, so 8h at 40h). With "Balance working days" on, billed time
// moves from weekdays above the target to weekdays below it, as little as
// needed:
//
//   - If the surplus covers the shortfall, every short day reaches the target,
//     and the longest days give first.
//   - Otherwise all the surplus moves, and the shortest days are raised first.
//
// The week's billed total never changes. It runs after the overtime trim, per
// week segment (weekSegments), so time never crosses the 1st of a month. An
// export of a range that starts or ends mid-week balances only the days inside
// it, since days outside were not loaded and would read as empty.
// Weekend days and holidays take no part: they keep what they have. Linked-code
// lines never move, since they must match the sub-client's sheet, but they
// count toward their day.
//
// The time moves with its billing line: the receiving day bills it on the same
// code with the same description.

import type { WeekSegment } from './overtime';
import type { HolidaySet } from '../calc';

/** A billed line on one day, in whole rounding units. */
export interface BalanceCell {
  day: number; // 0 = Sat … 6 = Fri
  units: number;
  // A linked-code line: counts toward its day but never moves.
  fixed?: boolean;
}

/** `units` of cell `cell` (an index into the input) move to day `toDay`. */
export interface BalanceMove {
  cell: number;
  toDay: number;
  units: number;
}

/** A half-open time range (ms). Only days starting inside it are balanced. */
export interface BalanceRange {
  fromMs: number;
  toMs: number;
}

/**
 * The working weekdays of a segment and each one's target in units. The
 * segment's cap (weeklyHours / 5 per working weekday) is spread evenly, with any
 * remainder unit going to the earliest days, so the targets add up to the cap.
 * With `inRange`, days for which it returns false are left out.
 */
export function segmentTargets(
  seg: WeekSegment,
  holidays: HolidaySet,
  inRange?: (day: number) => boolean
): Map<number, number> {
  const workdays: number[] = [];
  for (let d = Math.max(2, seg.startDay); d <= seg.endDay; d++) {
    if (!holidays.has(d)) workdays.push(d);
  }
  const targets = new Map<number, number>();
  if (workdays.length === 0) return targets;
  const base = Math.floor(seg.capUnits / workdays.length);
  const extra = seg.capUnits - base * workdays.length;
  workdays.forEach((d, i) => {
    if (!inRange || inRange(d)) targets.set(d, base + (i < extra ? 1 : 0));
  });
  return targets;
}

/**
 * Plan the moves that bring each day in `targets` toward its target. Cells on
 * other days are ignored. A giving day gives from its cells in input order, so
 * the caller lists them in the order they should go. Moves pair giving and
 * receiving days in day order.
 */
export function planBalance(cells: BalanceCell[], targets: Map<number, number>): BalanceMove[] {
  const days = [...targets.keys()].sort((a, b) => a - b);
  const total = new Map(days.map((d) => [d, 0]));
  const movable = new Map(days.map((d) => [d, 0]));
  cells.forEach((c) => {
    if (!targets.has(c.day) || c.units <= 0) return;
    total.set(c.day, total.get(c.day)! + c.units);
    if (!c.fixed) movable.set(c.day, movable.get(c.day)! + c.units);
  });

  // What each day can give (surplus it can move) and needs (shortfall).
  const canGive = new Map(
    days.map((d) => [d, Math.min(movable.get(d)!, Math.max(0, total.get(d)! - targets.get(d)!))])
  );
  const needs = new Map(days.map((d) => [d, Math.max(0, targets.get(d)! - total.get(d)!)]));
  const sum = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const move = Math.min(sum(canGive), sum(needs));
  if (move <= 0) return [];

  // One unit at a time: the longest giving day gives, the shortest short day
  // receives. Ties go to the earlier day.
  const gives = new Map(days.map((d) => [d, 0]));
  const gets = new Map(days.map((d) => [d, 0]));
  const level = new Map(total);
  const pick = (
    ok: (d: number) => boolean,
    better: (a: number, b: number) => boolean
  ): number => {
    let best = -1;
    for (const d of days) if (ok(d) && (best < 0 || better(level.get(d)!, level.get(best)!))) best = d;
    return best;
  };
  for (let k = 0; k < move; k++) {
    const from = pick((d) => gives.get(d)! < canGive.get(d)!, (a, b) => a > b);
    gives.set(from, gives.get(from)! + 1);
    level.set(from, level.get(from)! - 1);
  }
  for (let k = 0; k < move; k++) {
    const to = pick((d) => gets.get(d)! < needs.get(d)!, (a, b) => a < b);
    gets.set(to, gets.get(to)! + 1);
    level.set(to, level.get(to)! + 1);
  }

  // Take each giving day's units from its movable cells in input order, then
  // hand the pieces to the receiving days in day order.
  const pieces: { cell: number; units: number }[] = [];
  for (const d of days) {
    let left = gives.get(d)!;
    cells.forEach((c, i) => {
      if (left <= 0 || c.day !== d || c.fixed || c.units <= 0) return;
      const take = Math.min(left, c.units);
      pieces.push({ cell: i, units: take });
      left -= take;
    });
  }
  const moves: BalanceMove[] = [];
  let p = 0;
  for (const d of days) {
    let want = gets.get(d)!;
    while (want > 0 && p < pieces.length) {
      const take = Math.min(want, pieces[p].units);
      moves.push({ cell: pieces[p].cell, toDay: d, units: take });
      pieces[p].units -= take;
      want -= take;
      if (pieces[p].units === 0) p++;
    }
  }
  return moves;
}
