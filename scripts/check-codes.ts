// Content checks for billing-code parsing — in particular the workspace's
// "strip parentheses from billing codes" setting. Run with:
//   npm run check:codes
//
// The load-bearing claim is the ORDER of operations: the internal overtime
// markers "(X)" / "(!)" are interpreted FIRST, then (with the setting on) the
// remaining parenthetical groups are stripped, and only then is the base used
// — so the setting can never swallow a marker, and marker twins keep merging
// into the same displayed line. Off (the default) nothing changes at all.

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

const { parseBillingCode, stripCodeParens } = await import('../lib/calc.ts');
const { buildSummaryGrid } = await import('../lib/timesheet/summary.ts');
const { buildIndividualWeek } = await import('../lib/timesheet/individual.ts');

let checks = 0;
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepEqual(a, b, msg);
};

// ---- parseBillingCode: marker first, strip second ----

{
  eq(
    parseBillingCode('D123 (Phase 2)'),
    { base: 'D123 (Phase 2)', trimmable: false, neverTrim: false },
    'off by default: the parenthetical stays'
  );
  eq(
    parseBillingCode('D123 (Phase 2)', true),
    { base: 'D123', trimmable: false, neverTrim: false },
    'with the setting on, the parenthetical is stripped'
  );
  eq(
    parseBillingCode('D123 (X)', true),
    { base: 'D123', trimmable: true, neverTrim: false },
    'the "(X)" marker is interpreted first — never eaten as a parenthetical'
  );
  eq(
    parseBillingCode('D123 (Phase 2)(X)', true),
    { base: 'D123', trimmable: true, neverTrim: false },
    'marker first, then the remaining parenthetical strips'
  );
  eq(
    parseBillingCode('D123 (Phase 2) (!)', true),
    { base: 'D123', trimmable: false, neverTrim: true },
    'same for "(!)": never-trim survives the strip'
  );
  eq(
    parseBillingCode('D123 (Phase 2)(!)'),
    { base: 'D123 (Phase 2)', trimmable: false, neverTrim: true },
    'with the setting off, only the marker is removed'
  );
  eq(stripCodeParens('D1 (a) rest (b)'), 'D1 rest', 'every parenthetical group strips, not just the tail');
  eq(stripCodeParens('(only)'), '(only)', 'a code that is nothing but a parenthetical never vanishes');
}

// ---- the builders group by the stripped base ----

const WEEK = new Date(2026, 6, 4).getTime(); // Saturday 4/7/2026
const MON = new Date(2026, 6, 6);
const entry = (id: number, hour: number, durH: number, tag: string, desc: string) => ({
  id,
  start: new Date(MON.getTime() + hour * 3600e3).toISOString(),
  stop: new Date(MON.getTime() + (hour + durH) * 3600e3).toISOString(),
  duration: durH * 3600,
  project_id: 1,
  workspace_id: 1,
  description: desc,
  tags: [tag],
});
const base = {
  weekStart: WEEK,
  nowMs: MON.getTime() + 20 * 3600e3,
  projects: [{ id: 1, name: 'Proj' }],
  billingTagPrefix: 'D',
  roundingSeconds: 900,
  noOvertime: false,
  weeklyHours: 40,
};
const entries = [
  entry(1, 8, 1, 'D123 (Phase 1)', 'a'),
  entry(2, 10, 1, 'D123 (Phase 2)', 'b'),
  entry(3, 12, 1, 'D123 (Phase 1)(!)', 'c'),
];

{
  const tags = (strip: boolean) => {
    const grid = buildSummaryGrid({ ...base, entries, stripCodeParens: strip })!;
    return grid.rows.map((k: string) => grid.rowMeta.get(k)!.tag).sort();
  };
  eq(
    tags(false),
    ['D123 (Phase 1)', 'D123 (Phase 2)'],
    'off: distinct parentheticals keep distinct rows (the "(!)" twin still merges)'
  );
  eq(tags(true), ['D123'], 'on: the codes merge into one stripped row');
  const grid = buildSummaryGrid({ ...base, entries, stripCodeParens: true })!;
  const cell = grid.cells.get(`2|p1|D123`)!; // Monday is day index 2
  eq(cell.seconds, 3 * 3600, 'the merged row carries all three entries');
  eq(cell.noTrimSeconds, 3600, 'the "(!)" share survives as the never-trim floor');
}

{
  const codes = (strip: boolean) => {
    const week = buildIndividualWeek({
      ...base,
      entries,
      maxBillableHours: 8,
      stripCodeParens: strip,
    })!;
    return week.days.flatMap((d) => d.rows.map((r) => r.code));
  };
  eq(
    codes(false),
    ['D123 (Phase 1)', 'D123 (Phase 2)', 'D123 (Phase 1)'],
    'off: the Individual view lines keep their parentheticals'
  );
  // The stripped codes are what the combine rule sees, so the three consecutive
  // entries (1h gaps) now fold into ONE billed line — "then use" includes grouping.
  eq(codes(true), ['D123'], 'on: consecutive lines combine under the stripped code');
}

console.log(`✓ ${checks} billing-code checks passed`);
