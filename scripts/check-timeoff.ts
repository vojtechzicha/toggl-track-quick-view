// Checks for time off and billed time off. Run with `pnpm check:timeoff`.
//
// A time-off entry makes its day off: 0h target and a smaller weekly goal on
// the dashboard. A plain marker is never billed and lowers the timesheet's
// overtime cap by a day. With a billing tag as well, it bills as its own line,
// the day keeps its share of the cap, and the line counts toward the cap but is
// never trimmed, moved or merged (lib/timesheet/timeOff). The dashboard treats
// both the same. Bill by project, linked projects and support-ticket brackets
// never turn a marker into billed time off.

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

const { buildSummaryGrid } = await import('../lib/timesheet/summary.ts');
const { buildIndividualWeek } = await import('../lib/timesheet/individual.ts');
const { billsTimeOff } = await import('../lib/timesheet/timeOff.ts');
const { buildExportDoc } = await import('../lib/export/model.ts');
const { wholeWeeksRange } = await import('../lib/export/range.ts');
const { holidayDaysOfWeek, normalize, projectSecondsInRange, dailyTargetSeconds } = await import(
  '../lib/calc.ts'
);

let checks = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepEqual(a, b, msg);
};
const ok = (v: unknown, msg: string) => {
  checks++;
  assert.ok(v, msg);
};

const WEEK = new Date(2026, 6, 4).getTime(); // Saturday 4/7/2026
const dayAt = (day: number, hour: number) => {
  const d = new Date(WEEK);
  d.setDate(d.getDate() + day);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};
let nextId = 1;
const entry = (day: number, hour: number, durH: number, tags: string[], desc = '', project = 1) => {
  const start = dayAt(day, hour);
  return {
    id: nextId++,
    start: new Date(start).toISOString(),
    stop: new Date(start + durH * 3600e3).toISOString(),
    duration: durH * 3600,
    project_id: project,
    workspace_id: 1,
    description: desc,
    tags,
  };
};
const OFF = '.Time Off';
const H = 3600;
const base = {
  weekStart: WEEK,
  nowMs: dayAt(7, 0),
  projects: [{ id: 1, name: 'Proj' }],
  maxBillableHours: 5, // above the 4.5h work entries, below the 8h time off
  billingTagPrefix: 'D',
  roundingSeconds: 900,
  startWindowSeconds: null,
  noOvertime: false,
  weeklyHours: 40,
  timeOffTag: OFF,
};
/** Mon–Thu: two lines of `half` hours each on D1. */
const work = (half: number) =>
  [2, 3, 4, 5].flatMap((d) => [entry(d, 8, half, ['D1'], 'build'), entry(d, 13, half, ['D1'], 'build')]);

// ---- which entries bill ----
{
  const rules = { timeOffTag: OFF, billingTagPrefix: 'D' };
  ok(billsTimeOff([OFF, 'D-HOL'], 1, rules), 'time off with a billing tag bills');
  ok(!billsTimeOff([OFF, 'D-HOL', 'D2'], 1, rules), 'two billing tags do not');
  ok(!billsTimeOff([OFF], 1, rules), 'a plain marker does not');
  ok(!billsTimeOff(['D-HOL'], 1, rules), 'a billing tag alone is ordinary work, not time off');
  ok(!billsTimeOff([OFF, 'D-HOL'], 1, { ...rules, billByProject: true }), 'never with Bill by project');
  ok(
    !billsTimeOff([OFF, 'S-HOL'], 2, {
      ...rules,
      codeMappings: [{ projectId: 2, tagPrefix: 'S', roundingHours: 0.25, targetCode: 'D-SUB' }],
    }),
    'never on a linked project'
  );
  ok(
    !billsTimeOff(['Dayoff'], 1, { timeOffTag: 'Dayoff', billingTagPrefix: 'D' }),
    'the time-off tag never counts as its own billing tag'
  );
}

// ---- a plain marker: unchanged ----
{
  const entries = [...work(4.5), entry(6, 0, 0.25, [OFF], 'Public holiday')]; // 36h work, Fri off
  const grid = buildSummaryGrid({ ...base, entries, noOvertime: true })!;
  eq(grid.dayTotals, [8, 8, 8, 8, 0].map((h) => h * H), 'plain marker: the cap drops to 32h');
  eq(grid.overtimeTotal, 4 * H, 'plain marker: 4h trimmed');
  eq([...grid.holidays], [6], 'plain marker: Friday is a holiday');
  eq(grid.billedHolidays.size, 0, 'plain marker: nothing billed');
}

// ---- billed time off: the reported case ----
// Mon–Thu 9h of work, Friday a billed 8h holiday, 40h week, Don't bill overtime.
const billed = [...work(4.5), entry(6, 9, 8, [OFF, 'D-HOL'], 'Public holiday')];
{
  const grid = buildSummaryGrid({ ...base, entries: billed, noOvertime: true })!;
  eq(grid.dayTotals, [8, 8, 8, 8, 8].map((h) => h * H), 'billed: Mon–Thu trimmed to 8h, Friday bills 8h');
  eq(grid.grandTotal, 40 * H, 'billed: the week bills its full 40h');
  eq(grid.overtimeTotal, 4 * H, 'billed: only the 4h of real overtime is trimmed');
  eq(grid.rounded.get('6|t1|D-HOL'), 8 * H, 'billed: the time-off row');
  eq(grid.rowMeta.get('t1|D-HOL')?.timeOff, true, 'billed: the row is marked as time off');
  eq(grid.cells.get('6|t1|D-HOL')?.desc, 'Public holiday', 'billed: with its description');
  eq([...grid.holidays], [6], 'billed: Friday is still marked as a holiday');
  eq([...grid.billedHolidays], [6], 'billed: and as a billed one');

  const free = buildSummaryGrid({ ...base, entries: billed })!;
  eq(free.grandTotal, 44 * H, 'billed, no cap: work and time off bill in full');

  const ind = buildIndividualWeek({ ...base, entries: billed, noOvertime: true })!;
  eq(ind.grandTotal, 40 * H, 'individual: the week bills 40h');
  const fri = ind.days.find((d) => d.dayIdx === 6)!;
  eq(fri.rows.length, 1, 'individual: one Friday line, not flagged as too long (8h > 5h)');
  eq(
    [fri.rows[0].kind, fri.rows[0].code, fri.rows[0].rounded, fri.rows[0].timeOff],
    ['bill', 'D-HOL', 8 * H, true],
    'individual: the time-off line'
  );
  ok(fri.holiday && fri.holidayBilled, 'individual: Friday is a billed holiday');
  eq(fri.overtime, 0, 'individual: nothing trimmed from Friday');

  for (const view of ['summary', 'individual'] as const) {
    const doc = buildExportDoc({
      ...base,
      view,
      range: wholeWeeksRange({ fromMs: WEEK, toMs: dayAt(7, 0) }),
      entries: billed,
      noOvertime: true,
      multi: false,
      title: 'Proj',
      personName: '',
    });
    eq(doc.grandTotal, 40 * H, `${view} export: 40h, as on screen`);
    const codes =
      doc.view === 'summary'
        ? doc.weeks.flatMap((w) => w.rows.map((r) => r.billingCode))
        : doc.days.flatMap((d) => d.rows.map((r) => r.billingCode));
    ok(codes.includes('D-HOL'), `${view} export: the time-off line is exported`);
  }
}

// ---- the dashboard ignores the billing tag ----
{
  const ids = new Set([1]);
  eq([...holidayDaysOfWeek(billed, ids, WEEK, OFF)], [6], 'dashboard: Friday is off');
  const norm = normalize(billed, dayAt(7, 0), OFF);
  eq(
    projectSecondsInRange(norm, ids, WEEK, dayAt(7, 0)),
    36 * H,
    'dashboard: the billed holiday never counts as worked time'
  );
  const thu = new Date(dayAt(5, 12));
  const plain = [...work(4.5), entry(6, 0, 0.25, [OFF])];
  const cfg = { weeklyHours: 40, maxBillableHours: null, minWorkingDayHours: null };
  eq(
    dailyTargetSeconds(thu, normalize(billed, thu.getTime(), OFF), ids, false, cfg, new Set([6])),
    dailyTargetSeconds(thu, normalize(plain, thu.getTime(), OFF), ids, false, cfg, new Set([6])),
    'dashboard: targets are the same as with a plain marker'
  );
}

// ---- never trimmed, even with a disposable marker or a tight cap ----
{
  const tight = [...work(5), entry(6, 9, 8, [OFF, 'D-HOL(X)'], 'Public holiday')]; // 40h work
  const grid = buildSummaryGrid({ ...base, entries: tight, noOvertime: true })!;
  eq(grid.dayTotals, [8, 8, 8, 8, 8].map((h) => h * H), 'tight: work trimmed to 32h, time off whole');
  eq(grid.rounded.get('6|t1|D-HOL'), 8 * H, 'tight: "(X)" means nothing on time off');
  const ind = buildIndividualWeek({ ...base, entries: tight, noOvertime: true })!;
  eq(ind.days.find((d) => d.dayIdx === 6)!.total, 8 * H, 'tight: individual keeps Friday whole');
  eq(ind.grandTotal, 40 * H, 'tight: individual bills 40h');
}

// ---- half a day off, half a day of work ----
{
  const half = [
    ...work(4),
    entry(6, 8, 4, [OFF, 'D-HOL'], 'Half day off'),
    entry(6, 13, 5, ['D1'], 'build'),
  ];
  const grid = buildSummaryGrid({ ...base, entries: half, noOvertime: true })!;
  eq(grid.grandTotal, 40 * H, 'half day: the cap stays at 40h');
  eq(grid.rounded.get('6|t1|D-HOL'), 4 * H, 'half day: the time-off line is untouched');
  eq(grid.overtimeTotal, H, 'half day: the hour over 40h comes off the work');
  eq(
    grid.dayTotals,
    [8, 8, 8, 8, 8].map((h) => h * H),
    'half day: the time off counts toward Friday, so Friday’s work is trimmed, not Mon–Thu'
  );
  eq(grid.overtimeByDay[6], H, 'half day: the trimmed hour is Friday’s');
  const bal = buildSummaryGrid({ ...base, entries: half, noOvertime: true, balanceWeekdays: true })!;
  eq(bal.dayTotals, [8, 8, 8, 8, 8].map((h) => h * H), 'half day, balanced: every weekday at 8h');
  eq(bal.rounded.get('6|t1|D-HOL'), 4 * H, 'half day, balanced: the time-off line never moves');
}

// ---- balancing leaves the time-off line in place ----
{
  const uneven = [
    entry(2, 7, 5, ['D1'], 'build'), // Mon 10h
    entry(2, 13, 5, ['D1'], 'build'),
    entry(3, 8, 3, ['D1'], 'build'), // Tue 6h
    entry(3, 13, 3, ['D1'], 'build'),
    ...[4, 5].flatMap((d) => [entry(d, 8, 4, ['D1'], 'build'), entry(d, 13, 4, ['D1'], 'build')]),
    entry(6, 9, 8, [OFF, 'D-HOL'], 'Public holiday'),
  ];
  const opts = { ...base, entries: uneven, balanceWeekdays: true };
  const grid = buildSummaryGrid(opts)!;
  eq(grid.dayTotals, [8, 8, 8, 8, 8].map((h) => h * H), 'balance: Monday tops up Tuesday');
  eq(grid.balancedByDay[6], 0, 'balance: Friday neither gives nor receives');
  const ind = buildIndividualWeek(opts)!;
  eq(ind.days.map((d) => d.total / H), [8, 8, 8, 8, 8], 'balance: individual agrees');
}

// ---- rounding and rows ----
{
  // 7h55m of time off rounds to 8h on its own; same code as work, separate row.
  const shared = [
    entry(2, 8, 4.1, ['D1'], 'build'),
    entry(3, 9, 7 + 55 / 60, [OFF, 'D1'], 'Sick day'),
  ];
  const grid = buildSummaryGrid({ ...base, entries: shared })!;
  eq(grid.rounded.get('3|t1|D1'), 8 * H, 'rounding: the time-off line rounds on its own');
  eq(grid.rounded.get('2|p1|D1'), 4 * H, 'rounding: the work rounds as before');
  eq(
    grid.rows.filter((r) => grid.rowMeta.get(r)?.tag === 'D1'),
    ['p1|D1', 't1|D1'],
    'rows: time off never shares a row with work, and sorts after it'
  );
  const ind = buildIndividualWeek({ ...base, entries: shared })!;
  eq(ind.days.find((d) => d.dayIdx === 3)!.rows[0].timeOff, true, 'rows: individual marks the line');
}

// ---- warnings and the cases that stay plain markers ----
{
  const multi = buildSummaryGrid({
    ...base,
    entries: [entry(6, 9, 8, [OFF, 'D-HOL', 'D2'], 'Public holiday')],
  })!;
  eq(multi.rows, ['multiple'], 'two billing tags: a warning row, nothing billed');

  // A marker that bills nothing must not keep the cap either.
  const multiCapped = [...work(4.5), entry(6, 9, 8, [OFF, 'D-HOL', 'D2'], 'Public holiday')];
  const mg = buildSummaryGrid({ ...base, entries: multiCapped, noOvertime: true })!;
  eq(mg.billedHolidays.size, 0, 'two billing tags: the day is an unbilled holiday');
  eq(mg.grandTotal, 32 * H, 'two billing tags: the cap drops to 32h');
  ok(mg.rows.includes('multiple'), 'two billing tags: and the warning shows');
  const mi = buildIndividualWeek({ ...base, entries: multiCapped, noOvertime: true })!;
  eq(mi.grandTotal, 32 * H, 'two billing tags: individual caps at 32h too');
  ok(!mi.days.find((d) => d.dayIdx === 6)!.holidayBilled, 'two billing tags: not a billed holiday');

  const ticket = buildSummaryGrid({
    ...base,
    entries: [...work(4), entry(6, 9, 8, [OFF], '[HOL-1] Christmas')],
    noOvertime: true,
  })!;
  eq(ticket.grandTotal, 32 * H, 'a ticket bracket does not bill a marker');
  eq(ticket.billedHolidays.size, 0, 'and the day stays an unbilled holiday');

  const byProject = buildSummaryGrid({
    ...base,
    entries: [...work(4.5), entry(6, 9, 8, [OFF, 'D-HOL'], 'Public holiday')],
    noOvertime: true,
    billByProject: true,
  })!;
  eq(byProject.grandTotal, 32 * H, 'bill by project: the marker is not billed and the cap drops');

  const linked = buildSummaryGrid({
    ...base,
    projects: [
      { id: 1, name: 'Proj' },
      { id: 2, name: 'Sub' },
    ],
    entries: [...work(4.5), entry(6, 9, 8, [OFF, 'S-HOL'], 'Public holiday', 2)],
    noOvertime: true,
    codeMappings: [{ projectId: 2, tagPrefix: 'S', roundingHours: 0.25, targetCode: 'D-SUB' }],
  })!;
  eq(linked.grandTotal, 32 * H, 'linked project: the marker is not billed and the cap drops');
}

console.log(`✓ ${checks} time-off checks passed`);
