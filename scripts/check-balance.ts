// Checks for "Balance working days". Run with `pnpm check:balance`.
//
// Billed time moves from weekdays above the daily target (weeklyHours / 5) to
// weekdays below it, as little as needed. The week's total never changes;
// weekends, holidays and linked-code lines stay put, and time never crosses the
// 1st of a month. Both views and the export agree. Off by default, with no
// effect.

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

const { planBalance, segmentTargets } = await import('../lib/timesheet/balance.ts');
const { buildSummaryGrid } = await import('../lib/timesheet/summary.ts');
const { buildIndividualWeek } = await import('../lib/timesheet/individual.ts');
const { buildExportDoc } = await import('../lib/export/model.ts');

let checks = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepEqual(a, b, msg);
};
const ok = (v: unknown, msg: string) => {
  checks++;
  assert.ok(v, msg);
};

// ---- planBalance: the arithmetic, in units ----

const FULL_WEEK = new Map([2, 3, 4, 5, 6].map((d) => [d, 32])); // 8h on the 15-min unit
/** Day totals (Mon–Fri) after applying the moves to one cell per day. */
const after = (units: number[], targets = FULL_WEEK, fixed: boolean[] = []) => {
  const cells = units.map((u, i) => ({ day: i + 2, units: u, fixed: fixed[i] }));
  const totals = [...units];
  for (const m of planBalance(cells, targets)) {
    totals[cells[m.cell].day - 2] -= m.units;
    totals[m.toDay - 2] += m.units;
  }
  return totals;
};

{
  eq(after([36, 28, 32, 32, 32]), [32, 32, 32, 32, 32], 'a long Monday tops up a short Tuesday');
  eq(after([32, 32, 32, 32, 32]), [32, 32, 32, 32, 32], 'a balanced week is left alone');
  eq(
    after([40, 36, 28, 32, 32]),
    [36, 36, 32, 32, 32],
    'surplus over the shortfall: the short day reaches the target, the longest day gives first'
  );
  eq(
    after([36, 24, 26, 32, 32]),
    [32, 27, 27, 32, 32],
    'shortfall over the surplus: the two short days are raised toward a common level'
  );
  eq(
    after([36, 20, 28, 32, 32]),
    [32, 24, 28, 32, 32],
    'shortfall over the surplus: all the surplus moves, the shortest day is raised first'
  );
  eq(after([36, 32, 32, 32, 28], FULL_WEEK, [true]), [36, 32, 32, 32, 28], 'a linked line never moves');
  eq(after([0, 32, 32, 40, 32]), [8, 32, 32, 32, 32], 'an empty weekday receives too');
  eq(
    planBalance([{ day: 0, units: 20 }, { day: 2, units: 24 }], FULL_WEEK),
    [],
    'weekend time is never a donor'
  );

  const targets = segmentTargets({ startDay: 0, endDay: 6, capUnits: 152 }, new Set([4]));
  eq(
    [...targets],
    [[2, 38], [3, 38], [5, 38], [6, 38]],
    'a holiday takes no part, the cap is spread over the other weekdays'
  );
  eq(
    [...segmentTargets({ startDay: 0, endDay: 6, capUnits: 152 }, new Set())].map(([, t]) => t),
    [31, 31, 30, 30, 30],
    'an uneven cap (38h) gives the spare units to the earliest days, so the targets add up'
  );
  eq(segmentTargets({ startDay: 0, endDay: 1, capUnits: 0 }, new Set()).size, 0, 'a weekend-only segment has no targets');
}

// ---- the builders ----

const WEEK = new Date(2026, 6, 4).getTime(); // Saturday 4/7/2026
const dayAt = (weekStart: number, day: number, hour: number) => {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + day);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};
let nextId = 1;
const entry = (weekStart: number, day: number, hour: number, durH: number, tag: string, desc: string) => {
  const start = dayAt(weekStart, day, hour);
  return {
    id: nextId++,
    start: new Date(start).toISOString(),
    stop: new Date(start + durH * 3600e3).toISOString(),
    duration: durH * 3600,
    project_id: 1,
    workspace_id: 1,
    description: desc,
    tags: [tag],
  };
};
const base = {
  weekStart: WEEK,
  nowMs: dayAt(WEEK, 7, 0),
  projects: [{ id: 1, name: 'Proj' }],
  maxBillableHours: 4,
  billingTagPrefix: 'D',
  roundingSeconds: 900,
  startWindowSeconds: null,
  noOvertime: false,
  weeklyHours: 40,
};
const H = 3600;

// Mon 9h (4h D1, 4h D2, then 1h D3 at 17:00), Tue 7h, Wed–Fri 8h, Sat 3h.
const week = [
  entry(WEEK, 2, 8, 4, 'D1', 'design'),
  entry(WEEK, 2, 13, 4, 'D2', 'build'),
  entry(WEEK, 2, 17, 1, 'D3', 'review'),
  entry(WEEK, 3, 9, 3, 'D4', 'tests'),
  entry(WEEK, 3, 13, 4, 'D4', 'tests'),
  entry(WEEK, 4, 8, 4, 'D1', 'design'),
  entry(WEEK, 4, 13, 4, 'D1', 'design'),
  entry(WEEK, 5, 8, 4, 'D2', 'build'),
  entry(WEEK, 5, 13, 4, 'D2', 'build'),
  entry(WEEK, 6, 8, 4, 'D1', 'design'),
  entry(WEEK, 6, 13, 4, 'D1', 'design'),
  entry(WEEK, 0, 9, 3, 'D1', 'weekend'),
];

{
  const off = buildSummaryGrid({ ...base, entries: week })!;
  eq(off.dayTotals, [3 * H, 9 * H, 7 * H, 8 * H, 8 * H, 8 * H], 'off by default: days as tracked');
  eq(off.balancedByDay, [0, 0, 0, 0, 0, 0, 0], 'and nothing is reported as moved');

  const on = buildSummaryGrid({ ...base, entries: week, balanceWeekdays: true })!;
  eq(on.dayTotals, [3 * H, 8 * H, 8 * H, 8 * H, 8 * H, 8 * H], 'summary: every weekday at 8h, Saturday untouched');
  eq(on.grandTotal, off.grandTotal, 'summary: the week total is unchanged');
  eq(on.balancedByDay, [0, 0, -H, H, 0, 0, 0], 'summary: one hour reported as moved from Monday to Tuesday');
  // Monday's lines are 4h, 4h, 1h; the largest gives first.
  const moved = [...on.rounded].filter(([k, v]) => k.startsWith('3|') && v > 0 && !k.endsWith('D4'));
  eq(moved.length, 1, 'summary: the hour lands on one row of Tuesday');
  const movedKey = moved[0][0];
  ok(
    ['3|p1|D1', '3|p1|D2'].includes(movedKey) && moved[0][1] === H,
    'summary: taken from one of Monday’s largest rows'
  );
  const fromKey = movedKey.replace(/^3\|/, '2|');
  eq(on.rounded.get(fromKey), 3 * H, 'summary: the Monday row keeps the rest');
  eq(
    on.cells.get(movedKey)!.descs,
    on.cells.get(fromKey)!.descs,
    'summary: the moved time carries its description'
  );
}

{
  const off = buildIndividualWeek({ ...base, entries: week })!;
  const on = buildIndividualWeek({ ...base, entries: week, balanceWeekdays: true })!;
  const totals = (w: typeof on) => w.days.map((d) => [d.dayIdx, d.total / H]);
  eq(totals(on), [[0, 3], [2, 8], [3, 8], [4, 8], [5, 8], [6, 8]], 'individual: every weekday at 8h');
  eq(on.grandTotal, off.grandTotal, 'individual: the week total is unchanged');

  const fmt = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const lines = (dayIdx: number) =>
    on.days
      .find((d) => d.dayIdx === dayIdx)!
      .rows.map((r) => `${fmt(r.startMs!)}-${fmt(r.endMs!)} ${r.code} ${r.desc}`);
  eq(
    lines(2),
    ['08:00-12:00 D1 design', '13:00-17:00 D2 build'],
    'individual: Monday gives its latest line'
  );
  eq(
    lines(3),
    ['09:00-12:00 D4 tests', '13:00-17:00 D4 tests', '17:00-18:00 D3 review'],
    'individual: Tuesday keeps its lines and gets the hour after them, same code and description'
  );
  eq(
    on.days.map((d) => d.balanced / H),
    [0, -1, 1, 0, 0, 0],
    'individual: each day reports what it gave or got'
  );
}

{
  const range = { fromMs: WEEK, toMs: dayAt(WEEK, 7, 0) };
  const common = { ...base, entries: week, balanceWeekdays: true, range, multi: false, title: 'T', personName: '' };
  const summary = buildExportDoc({ ...common, view: 'summary' });
  const individual = buildExportDoc({ ...common, view: 'individual' });
  eq(
    summary.view === 'summary' && summary.weeks[0].dayTotals,
    [3 * H, 8 * H, 8 * H, 8 * H, 8 * H, 8 * H],
    'the summary export shows the balanced days'
  );
  eq(
    individual.view === 'individual' && individual.days.map((d) => d.total / H),
    [3, 8, 8, 8, 8, 8],
    'so does the individual export'
  );
}

// An export of a mid-week range loads only that range's entries. Days outside it
// must not soak up time the export then drops.
{
  const midweek = [
    entry(WEEK, 2, 8, 8, 'D1', 'a'), // Mon, outside the range
    entry(WEEK, 4, 8, 4, 'D1', 'a'),
    entry(WEEK, 4, 13, 4, 'D1', 'a'),
    entry(WEEK, 4, 17, 2, 'D1', 'a'), // Wed 10h
    entry(WEEK, 5, 8, 4, 'D1', 'a'),
    entry(WEEK, 5, 13, 2, 'D1', 'a'), // Thu 6h
    entry(WEEK, 6, 8, 4, 'D1', 'a'),
    entry(WEEK, 6, 13, 4, 'D1', 'a'), // Fri 8h
  ];
  const range = { fromMs: dayAt(WEEK, 4, 0), toMs: dayAt(WEEK, 7, 0) }; // Wed–Fri
  const loaded = midweek.filter((e) => new Date(e.start).getTime() >= range.fromMs);
  const common = { ...base, entries: loaded, balanceWeekdays: true, range, multi: false, title: 'T', personName: '' };
  const summary = buildExportDoc({ ...common, view: 'summary' });
  eq(
    summary.view === 'summary' && summary.weeks[0].dayTotals,
    [8 * H, 8 * H, 8 * H],
    'a Wed–Fri summary export balances among its own days'
  );
  eq(summary.grandTotal, 24 * H, 'and keeps every tracked hour');
  const individual = buildExportDoc({ ...common, view: 'individual' });
  eq(
    individual.view === 'individual' && individual.days.map((d) => d.total / H),
    [8, 8, 8],
    'so does the individual export'
  );
  eq(individual.grandTotal, 24 * H, 'with every tracked hour');
}

// A 1h week on the 1-hour unit: Monday's target is 1h, the rest 0h. Tuesday
// gives its whole hour away and must still show, with what it gave.
{
  const tiny = buildIndividualWeek({
    ...base,
    entries: [entry(WEEK, 3, 9, 1, 'D1', 'a')],
    roundingSeconds: 3600,
    weeklyHours: 1,
    balanceWeekdays: true,
  })!;
  eq(
    tiny.days.map((d) => [d.dayIdx, d.total / H, d.balanced / H]),
    [[2, 1, 1], [3, 0, -1]],
    'a day emptied by balancing still shows what it gave'
  );
}

// With "Don't bill overtime": trimmed to the cap first, then balanced.
{
  const over = [
    entry(WEEK, 2, 8, 4, 'D1', 'a'),
    entry(WEEK, 2, 13, 4, 'D1', 'a'),
    entry(WEEK, 2, 17, 2, 'D1', 'a'), // Mon 10h
    entry(WEEK, 3, 8, 4, 'D1', 'a'),
    entry(WEEK, 3, 13, 2, 'D1', 'a'), // Tue 6h
    ...[4, 5].flatMap((d) => [entry(WEEK, d, 8, 4, 'D1', 'a'), entry(WEEK, d, 13, 4, 'D1', 'a')]),
    entry(WEEK, 6, 8, 4, 'D1', 'a'),
    entry(WEEK, 6, 13, 4, 'D1', 'a'),
    entry(WEEK, 6, 17, 1, 'D1', 'a'), // Fri 9h, 41h in all
  ];
  const opts = { ...base, entries: over, noOvertime: true, balanceWeekdays: true };
  const grid = buildSummaryGrid(opts)!;
  eq(grid.dayTotals, [8, 8, 8, 8, 8].map((h) => h * H), 'with the cap: summary days all at 8h');
  eq(grid.overtimeTotal, H, 'and the hour over the cap is still trimmed');
  const ind = buildIndividualWeek(opts)!;
  eq(ind.days.map((d) => d.total / H), [8, 8, 8, 8, 8], 'with the cap: individual days all at 8h');
}

// A holiday and a short week: Wed is off, so its 2h stays and the others balance.
{
  const holiday = [
    entry(WEEK, 2, 8, 9, 'D1', 'a'),
    entry(WEEK, 3, 8, 7, 'D1', 'a'),
    entry(WEEK, 4, 8, 0.25, 'Time off', ''),
    entry(WEEK, 4, 10, 2, 'D1', 'a'),
    entry(WEEK, 5, 8, 8, 'D1', 'a'),
    entry(WEEK, 6, 8, 8, 'D1', 'a'),
  ];
  const grid = buildSummaryGrid({
    ...base,
    entries: holiday,
    balanceWeekdays: true,
    timeOffTag: 'Time off',
  })!;
  eq(grid.dayTotals, [8, 8, 2, 8, 8].map((h) => h * H), 'a holiday keeps its hours and takes no part');
}

// The 1st on a Tuesday: Monday's surplus cannot reach Tuesday.
{
  const SPLIT = new Date(2026, 7, 29).getTime(); // Saturday 29/8/2026; 1/9 is Tuesday
  const split = [
    entry(SPLIT, 2, 8, 10, 'D1', 'a'),
    entry(SPLIT, 3, 8, 6, 'D1', 'a'),
    entry(SPLIT, 4, 8, 10, 'D1', 'a'),
    entry(SPLIT, 5, 8, 8, 'D1', 'a'),
    entry(SPLIT, 6, 8, 8, 'D1', 'a'),
  ];
  const grid = buildSummaryGrid({
    ...base,
    entries: split,
    weekStart: SPLIT,
    nowMs: dayAt(SPLIT, 7, 0),
    balanceWeekdays: true,
  })!;
  eq(
    grid.dayTotals,
    [10, 8, 8, 8, 8].map((h) => h * H),
    'August’s Monday keeps its surplus; September’s days balance among themselves'
  );
}

console.log(`✓ ${checks} balance checks passed`);
