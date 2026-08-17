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
//
// Every fixture and assertion below is written in *local* clock time, so the same
// expectations must hold in any timezone. They're replayed in a few (including
// half-hour offsets, where a grid laid over the epoch would land on :30 instead of
// the promised :00) — Node re-reads process.env.TZ on the next Date call.

// Each with its July offset (minutes east of UTC), so the replay can prove it
// really switched zone — half-hour offsets are the interesting ones here.
const TIMEZONES: [string, number][] = [
  ['UTC', 0],
  ['Europe/Prague', 120],
  ['Asia/Kolkata', 330],
  ['Australia/Adelaide', 570],
];

function scenarios(tz: string) {
  const where = ` (TZ=${tz})`;
  const WEEK = new Date(2026, 6, 4).getTime(); // Saturday 4/7/2026
  const MON = new Date(2026, 6, 6).getTime();
  const at = (h: number, m: number) => new Date(MON + h * 3600e3 + m * 60e3).getTime();
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

  const build = (
    entries: ReturnType<typeof entry>[],
    startWindowSeconds: number | null,
    roundingSeconds = 900
  ) =>
    buildIndividualWeek({
      entries,
      weekStart: WEEK,
      nowMs: at(23, 59),
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
      d.rows.map((r) => `${fmt(r.startMs as number)}\u2013${fmt(r.endMs as number)}`)
    );
  const minutes = (week: ReturnType<typeof build>) =>
    week.days.flatMap((d) => d.rows.map((r) => r.rounded / 60));

  // 38 min then 30 min, on different codes so they stay two lines. Rounded on the
  // 15-min unit the day totals 5 units (75 min): 45 min for the first line (it has
  // the larger remainder) and 30 for the second.
  const morning = [entry(1, [8, 0], [8, 38], 'D1'), entry(2, [8, 40], [9, 10], 'D2')];

  {
    const linked = build(morning, null);
    eq(
      spans(linked),
      ['08:00\u201308:45', '08:45\u201309:15'],
      'no window: starts snap to the 15-min unit and pack forward, exactly as before' + where
    );
    eq(minutes(linked), [45, 30], 'the day rounds to 45 + 30 min on the 15-min unit' + where);
  }

  {
    // The second line's own mark (08:30) is already behind the first line's end
    // (08:45), so it moves on to the NEXT half-hour rather than starting at 08:45.
    const half = build(morning, 1800);
    eq(
      spans(half),
      ['08:00\u201308:45', '09:00\u201309:30'],
      'a 30-min window: both lines start on a half-hour mark, the packed one on the next' + where
    );
    eq(minutes(half), [45, 30], 'the window leaves the rounded durations alone' + where);
    eq(
      half.days.map((d) => d.total),
      build(morning, null).days.map((d) => d.total),
      'and leaves the billed day total alone' + where
    );
    ok(
      spans(half).every((s) => /^\d\d:(00|30)\u2013/.test(s)),
      'every start sits on :00 or :30 of the local clock' + where
    );
  }

  {
    const hourly = build(morning, 3600);
    eq(
      spans(hourly),
      ['08:00\u201308:45', '09:00\u201309:30'],
      'an hourly window: the second line starts on the next whole local hour' + where
    );
  }

  {
    eq(
      spans(build(morning, 900)),
      spans(build(morning, null)),
      'a window equal to the unit changes nothing' + where
    );
    eq(
      spans(build(morning, 300)),
      spans(build(morning, null)),
      'nor does a window finer than the unit' + where
    );
    eq(
      spans(build(morning, 1800, 1800)),
      spans(build(morning, null, 1800)),
      'nor a 30-min window on a sheet already rounding to 30 min' + where
    );
  }

  {
    // A line's own mark never leaves the day it was tracked on: 23:40 is nearest to
    // tomorrow's 00:00 on both grids, so it falls back to the day's last mark.
    const late = [entry(3, [23, 40], [23, 55], 'D1')];
    eq(
      spans(build(late, 3600)),
      ['23:00\u201323:15'],
      'an hourly window: a late line falls back to the day\u2019s last mark' + where
    );
    eq(
      spans(build(late, null)),
      ['23:45\u201300:00'],
      'the linked grid keeps its own nearest mark, which is still inside the day' + where
    );
    // Nearest mark on the linked 15-min grid is tomorrow's 00:00 too, so the same
    // clamp keeps this one on its own date (it used to be shown under the next day).
    const veryLate = [entry(4, [23, 53], [24, 10], 'D1')];
    eq(
      spans(build(veryLate, null)),
      ['23:45\u201300:00'],
      'the clamp holds on the linked grid as well, not just on a coarse window' + where
    );
  }
}

for (const [tz, offsetMin] of TIMEZONES) {
  process.env.TZ = tz;
  // Guard the replay itself: a runtime that ignored the change would silently run
  // the same zone four times and prove nothing.
  eq(
    0 - new Date(2026, 6, 6, 12, 0).getTimezoneOffset() || 0,
    offsetMin,
    `the checks below really run in ${tz}`
  );
  scenarios(tz);
}

console.log(`\u2713 ${checks} start-window checks passed`);
