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

const { startWindowUnitSeconds, addDays, startOfWeek, holidayDaysOfWeek, futureDaysShowPlan } =
  await import('../lib/calc.ts');
const { buildIndividualWeek } = await import('../lib/timesheet/individual.ts');
const { buildSummaryGrid } = await import('../lib/timesheet/summary.ts');
const { weeksInRange, rangeFromInputs } = await import('../lib/export/range.ts');

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

// ---- clock changes: days are calendar days, not 24h blocks ----
//
// A week holding a clock change is 167h or 169h long. Stepping it in fixed 24h
// blocks moved every entry within an hour of midnight onto the neighbouring day
// (Sunday 23:30 billed on Monday in autumn, Monday 00:30 on Sunday in spring),
// dropped Friday's last hour in autumn, and — through the week stepping — made
// every later week of an export or the week picker start at Fri 23:00 or Sat 01:00.
// Replayed in zones whose changes fall on different Sundays (and one with a
// half-hour offset), with UTC as the no-change control.

const DST_ZONES = ['UTC', 'Europe/Prague', 'America/New_York', 'Australia/Adelaide'];

function dstScenarios(tz: string) {
  const where = ` (TZ=${tz})`;
  const offsetAt = (ms: number) => new Date(ms).getTimezoneOffset();
  const isLocalMidnight = (ms: number) => {
    const d = new Date(ms);
    return d.getHours() === 0 && d.getMinutes() === 0;
  };

  // Every Saturday-week of 2026 by calendar, and the ones a clock change falls in.
  const year = weeksInRange(new Date(2026, 0, 1).getTime(), new Date(2027, 0, 1).getTime());
  ok(
    year.every((ws) => new Date(ws).getDay() === 6 && isLocalMidnight(ws)),
    'every week an export spans starts on a Saturday midnight' + where
  );
  const changeWeeks = year.filter((ws) => offsetAt(ws) !== offsetAt(addDays(ws, 7)));
  eq(changeWeeks.length, tz === 'UTC' ? 0 : 2, 'the zone really has two clock changes' + where);

  // The week picker steps back from the current week the same way.
  const nov = startOfWeek(new Date(2026, 10, 20)).getTime();
  for (let i = 1; i <= 52; i++) {
    const ws = addDays(nov, -7 * i);
    ok(new Date(ws).getDay() === 6 && isLocalMidnight(ws), `picker week -${i} starts on Saturday midnight` + where);
  }

  for (const ws of changeWeeks) {
    const label = `week of ${new Date(ws).toDateString()}`;
    for (let d = 0; d <= 7; d++) {
      const day = addDays(ws, d);
      ok(isLocalMidnight(day), `day ${d} of the ${label} starts at local midnight` + where);
      eq(new Date(day).getDay(), (d + 6) % 7, `day ${d} of the ${label} is the right weekday` + where);
    }

    // Two entries a day — 00:30 and 23:30 — each tagged with the day it was
    // tracked on, so any entry bucketed onto a neighbouring day shows up.
    const entries = Array.from({ length: 7 }, (_, d) =>
      [0, 23].map((h) => {
        const start = new Date(addDays(ws, d));
        start.setHours(h, 30, 0, 0);
        return {
          id: d * 2 + (h ? 1 : 0),
          start: start.toISOString(),
          stop: new Date(start.getTime() + 15 * 60e3).toISOString(),
          duration: 900,
          project_id: 1,
          workspace_id: 1,
          description: `d${d}`,
          tags: [`D${d}`],
        };
      })
    ).flat();
    const common = {
      entries,
      weekStart: ws,
      nowMs: addDays(ws, 8),
      projects: [{ id: 1, name: 'Proj' }],
      billingTagPrefix: 'D',
      roundingSeconds: 900,
      noOvertime: false,
      weeklyHours: 40,
    };

    const grid = buildSummaryGrid(common)!;
    const billed = [...grid.rounded.entries()].filter(([, v]) => v > 0);
    eq(billed.length, 7, `the summary bills one cell per day in the ${label}` + where);
    for (const [key, v] of billed) {
      const [day, , tag] = key.split('|');
      eq(tag, `D${day}`, `summary: ${tag}'s entries stay on their own day in the ${label}` + where);
      eq(v, 1800, `summary: both of ${tag}'s entries are counted in the ${label}` + where);
    }

    const week = buildIndividualWeek({ ...common, maxBillableHours: 4, startWindowSeconds: null })!;
    eq(week.days.map((d) => d.dayIdx), [0, 1, 2, 3, 4, 5, 6], `individual: all seven days in the ${label}` + where);
    for (const d of week.days) {
      eq(d.dateMs, addDays(ws, d.dayIdx), `individual: day ${d.dayIdx} is dated its own midnight` + where);
      eq(
        d.rows.map((r) => r.code),
        [`D${d.dayIdx}`, `D${d.dayIdx}`],
        `individual: day ${d.dayIdx} holds exactly its own two entries in the ${label}` + where
      );
    }

    // A time-off marker late on the change day, or late on Friday, stays put.
    const marker = (d: number) => {
      const start = new Date(addDays(ws, d));
      start.setHours(23, 30, 0, 0);
      return { ...entries[0], start: start.toISOString(), tags: ['holiday'] };
    };
    eq(
      [...holidayDaysOfWeek([marker(1), marker(6)], new Set([1]), ws, 'holiday')].sort(),
      [1, 6],
      `late time-off markers stay on their own day in the ${label}` + where
    );

    // The inclusive "to" day of a hand-picked range ends at the next midnight.
    const sunday = new Date(addDays(ws, 1));
    const iso = `${sunday.getFullYear()}-${String(sunday.getMonth() + 1).padStart(2, '0')}-${String(sunday.getDate()).padStart(2, '0')}`;
    eq(rangeFromInputs(iso, iso)!.toMs, addDays(ws, 2), `a one-day range over the change Sunday` + where);
  }
}

for (const tz of DST_ZONES) {
  process.env.TZ = tz;
  dstScenarios(tz);
}

// ---- the week summary's plan-vs-adaptive switch follows the Saturday week ----
//
// Saturday opens the week, so its future days show the plain plan like Sun–Wed.
// Read off getDay() it counted as past Thursday (6 >= 4) and projected the
// weekend's fallback target as worked time, inflating Thursday and Friday.
{
  const ws = new Date(2026, 8, 19, 10).getTime(); // Saturday
  eq(
    Array.from({ length: 7 }, (_, d) => futureDaysShowPlan(new Date(addDays(ws, d)))),
    [true, true, true, true, true, false, false],
    'the plan shows Sat–Wed, the adaptive targets Thu–Fri'
  );
}

console.log(`✓ ${checks} start-window checks passed`);
