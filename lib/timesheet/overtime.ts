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
//      of the lines is trimmed too.
//
// Within each tier the cut is spread proportionally to each line's available size
// (the same largest-remainder / Hamilton method the rounding uses), so the reduction
// lands as evenly as possible across codes and days. A line may be reduced all the
// way to zero. The trimmed time is never billed — the views surface it on a separate
// "Overtime" line so it stays visible.

export interface TrimCell {
  units: number; // current rounded duration, in whole rounding units
  trimmableUnits: number; // the "(X)"-marked portion of those units (0 ≤ this ≤ units)
}

/**
 * Whole rounding units to remove from each cell so the billable total drops to
 * `capUnits`. Returns an array aligned with the input (0 = untouched). When already
 * at or under the cap, nothing is removed.
 */
export function allocateOvertimeTrim(cells: TrimCell[], capUnits: number): number[] {
  const removed = new Array<number>(cells.length).fill(0);
  const total = cells.reduce((s, c) => s + c.units, 0);
  let excess = total - Math.max(0, capUnits);
  if (excess <= 0) return removed;

  // Tier 1: each line's trimmable "(X)" portion. Tier 2: whatever firm time is left.
  excess = trimTier(cells, removed, excess, (c, i) =>
    Math.max(0, Math.min(c.trimmableUnits, c.units) - removed[i])
  );
  trimTier(cells, removed, excess, (c, i) => c.units - removed[i]);
  return removed;
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

/** Whole rounding units that fit under a weekly hours cap (floored, so never over). */
export function capUnits(weeklyHours: number, roundingSeconds: number): number {
  if (weeklyHours <= 0 || roundingSeconds <= 0) return 0;
  return Math.floor((weeklyHours * 3600) / roundingSeconds);
}
