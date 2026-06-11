// Overtime trimming, shared by both timesheet views (and so every export).
//
// When an engagement contractually disallows billing overtime, the timesheet must
// not report more than the weekly cap (weeklyHours) even though the extra time was
// genuinely tracked. This module decides how many whole rounding units to shave off
// the week's billable lines to bring the *billed* total down to the cap, in two
// tiers:
//
//   1. Lines whose billing code carries the internal "(X)" marker are emptied first
//      (they're explicitly the disposable buffer).
//   2. Only if still over the cap, the remaining billable lines are trimmed too.
//
// Within each tier the cut is spread proportionally to each line's size (the same
// largest-remainder / Hamilton method the rounding uses), so the reduction lands as
// evenly as possible across codes and days. A line may be reduced all the way to
// zero. The trimmed time is never billed — the views surface it on a separate
// "Overtime" line so it stays visible.

export interface TrimCell {
  units: number; // current rounded duration, in whole rounding units
  trimmable: boolean; // billing code carries the "(X)" overtime marker
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

  // Trimmable lines first, then the rest — each tier exhausted before the next.
  for (const tier of [true, false]) {
    if (excess <= 0) break;
    const idx = cells
      .map((_, i) => i)
      .filter((i) => cells[i].trimmable === tier && cells[i].units > 0);
    const capacity = idx.reduce((s, i) => s + cells[i].units, 0);
    const take = Math.min(excess, capacity);
    if (take <= 0) continue;
    const alloc = apportion(
      take,
      idx.map((i) => cells[i].units)
    );
    idx.forEach((i, k) => (removed[i] += alloc[k]));
    excess -= take;
  }
  return removed;
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
