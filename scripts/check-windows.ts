// Content checks for the Individual view's start-time window — the setting that
// unlinks *when a line may start* from the unit its duration is rounded to. Run with:
//   npm run check:windows
//
// The load-bearing claims: durations keep rounding on the rounding unit (the window
// never touches an hours figure), every displayed start lands on a window mark —
// including a line pushed forward by the one before it, which moves on to the NEXT
// mark rather than drifting off the window — and a window that isn't coarser than
// the rounding unit is exactly the old linked behaviour.

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';

const ROOT = new URL('../', import.meta.url);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@/')) {
      return { url: new URL(specifier.slice(2) + '.ts', ROOT).href, shortCircuit: true };
    }
    // Next resolves extensionless relative imports; node needs them spelled out.
    if (specifier.startsWith('.') && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      for (const ext of ['.ts', '.tsx']) {
        const u = new URL(specifier + ext, context.parentURL);
        if (fs.existsSync(u)) return { url: u.href, shortCircuit: true };
      }
    }
    return next(specifier, context);
  },
});

const { startWindowUnitSeconds } = await import('../lib/calc.ts');
const { buildIndividualWeek } = await import('../lib/timesheet/individual.ts');

let checks = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepEqual(a, b, msg);
};
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};

// ---- startWindowUnitSeconds: only a coarser window wins ----

{
  eq(startWindowUnitSeconds(null, 900), 900, 'no window: start times follow the rounding unit');
  eq(startWindowUnitSeconds(undefined, 720), 720, 'same for settings stored before the window existed');
  eq(startWindowUnitSeconds(0.5, 900), 1800, 'a coarser window is what the times snap to');
  eq(startWindowUnitSeconds(0.25, 900), 900, 'a window equal to the unit is the linked default');
  eq(startWindowUnitSeconds(0.25, 3600), 3600, 'a finer window can never take times off the unit');
  eq(startWindowUnitSeconds(1, 720), 3600, 'the two grids need not divide each other');
}

// ---- the builder anchors starts to the window ----

const WEEK = new Date(2026, 6, 4).getTime(); // Saturday 4/7/2026
const MON = new Date(2026, 6, 6).getTime();
const at = (h: number, m: number) => MON + h * 3600e3 + m * 60e3;
const entry = (id: number, from: [number, number], to: [number, number], tag: string) => ({
  id,
  start: new Date(at(from[0], from[1])).toISOString(),
  stop: new Date(at(to[0], to[1])).toISOString(),
  duration: (at(to[0], to[1]) - at(from[0], from[1])) / 1000,
  project_id: 1,
  workspace_id: 1,
  description: `e${id}`,
  tags: [tag],
});

// 38 min then 30 min, on different codes so they stay two lines. Rounded on the
// 15-min unit the day totals 5 units (75 min): 45 min for the first line (it has
// the larger remainder) and 30 for the second.
const entries = [
  entry(1, [8, 0], [8, 38], 'D1'),
  entry(2, [8, 40], [9, 10], 'D2'),
];

const build = (startWindowSeconds: number | null, roundingSeconds = 900) =>
  buildIndividualWeek({
    entries,
    weekStart: WEEK,
    nowMs: at(20, 0),
    projects: [{ id: 1, name: 'Proj' }],
    maxBillableHours: 4,
    billingTagPrefix: 'D',
    roundingSeconds,
    startWindowSeconds,
    noOvertime: false,
    weeklyHours: 40,
  })!;

const fmt = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const spans = (week: ReturnType<typeof build>) =>
  week.days.flatMap((d) =>
    d.rows.map((r) => `${fmt(r.startMs as number)}–${fmt(r.endMs as number)}`)
  );
const minutes = (week: ReturnType<typeof build>) =>
  week.days.flatMap((d) => d.rows.map((r) => r.rounded / 60));

{
  const linked = build(null);
  eq(
    spans(linked),
    ['08:00–08:45', '08:45–09:15'],
    'no window: starts snap to the 15-min unit and pack forward, exactly as before'
  );
  eq(minutes(linked), [45, 30], 'the day rounds to 45 + 30 min on the 15-min unit');
}

{
  // The second line's own mark (08:30) is already behind the first line's end
  // (08:45), so it moves on to the NEXT half-hour rather than starting at 08:45.
  const half = build(1800);
  eq(
    spans(half),
    ['08:00–08:45', '09:00–09:30'],
    'a 30-min window: both lines start on a half-hour mark, the packed one on the next'
  );
  eq(minutes(half), [45, 30], 'the window leaves the rounded durations alone');
  eq(
    half.days.map((d) => d.total),
    build(null).days.map((d) => d.total),
    'and leaves the billed day total alone'
  );
  ok(
    spans(half).every((s) => /^\d\d:(00|30)–/.test(s)),
    'every start sits on :00 or :30'
  );
}

{
  const hourly = build(3600);
  eq(
    spans(hourly),
    ['08:00–08:45', '09:00–09:30'],
    'an hourly window: the second line starts on the next whole hour'
  );
}

{
  eq(spans(build(900)), spans(build(null)), 'a window equal to the unit changes nothing');
  eq(spans(build(300)), spans(build(null)), 'nor does a window finer than the unit');
  eq(
    spans(build(1800, 1800)),
    spans(build(null, 1800)),
    'nor a 30-min window on a sheet already rounding to 30 min'
  );
}

console.log(`✓ ${checks} start-window checks passed`);
