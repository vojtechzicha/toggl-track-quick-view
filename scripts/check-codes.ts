// Checks for billing-code handling. Run with `pnpm check:codes`.
//
// "Strip parentheses from billing codes": the "(X)" / "(!)" markers are read
// before the other parenthetical groups are stripped, so the setting never
// removes a marker and marked codes still merge with their plain base. Off by
// default, with no effect.
//
// "Bill by project": the project is the billing line. No entry is untagged or
// multi-tagged, and billing tags, ticket brackets, markers, parentheticals and
// linked-code mappings have no effect. Rounding, the billable cap and the
// overtime trim still apply.

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
    'the "(X)" marker is read before stripping'
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
  // Combining uses the stripped code, so the three entries (1h gaps) become one
  // line.
  eq(codes(true), ['D123'], 'on: consecutive lines combine under the stripped code');
}

// ---- bill by project: billing codes have no effect ----

// One entry per billing-code shape, all on one project: a tag, no tag, two
// tags, a ticket bracket and an "(X)" marker. Billing by project, all of them
// land on one "Proj" row with nothing flagged.
const mixed = [
  { ...entry(1, 8, 1, 'D123', 'tagged'), tags: ['D123'] },
  { ...entry(2, 9, 1, 'D123', 'untagged'), tags: [] },
  { ...entry(3, 10, 1, 'D123', 'two tags'), tags: ['D123', 'D456'] },
  { ...entry(4, 11, 1, 'D123', '[T-9] ticketed'), tags: [] },
  { ...entry(5, 12, 1, 'D123(X)', 'marked'), tags: ['D123(X)'] },
];
const byProject = { ...base, entries: mixed, billByProject: true };

{
  const grid = buildSummaryGrid(byProject)!;
  eq(grid.rows, ['p1|Proj'], 'every entry lands on the project row, with no warning rows');
  eq(
    grid.rowMeta.get('p1|Proj')!.tag,
    'Proj',
    'the row is named after the project, not after any tag'
  );
  const cell = grid.cells.get('2|p1|Proj')!;
  eq(cell.seconds, 5 * 3600, 'all five entries bill, including the untagged and multi-tagged ones');
  eq(cell.trimmableSeconds, 0, 'an "(X)" tag is not an overtime marker here');
  eq(
    cell.descs.includes('[T-9] ticketed'),
    true,
    'a leading "[ticket]" stays in the description'
  );
  eq(grid.grandTotal, 5 * 3600, 'the day total counts them all');
}

{
  // Linked-code mappings are ignored when billing by project.
  const grid = buildSummaryGrid({
    ...byProject,
    codeMappings: [{ projectId: 1, tagPrefix: 'S', roundingHours: 0.25, targetCode: 'D-SUB-1' }],
  })!;
  eq(grid.rows, ['p1|Proj'], 'a linked-code mapping does not apply when billing by project');
}

{
  // Two projects give two rows.
  const two = [entry(1, 8, 1, 'D1', 'a'), { ...entry(2, 10, 1, 'D2', 'b'), project_id: 2 }];
  const grid = buildSummaryGrid({
    ...base,
    entries: two,
    projects: [
      { id: 1, name: 'Proj' },
      { id: 2, name: 'Other' },
    ],
    billByProject: true,
  })!;
  eq(grid.rows.sort(), ['p1|Proj', 'p2|Other'], 'each project bills on its own row');
}

{
  const week = buildIndividualWeek({ ...byProject, maxBillableHours: 8 })!;
  const rows = week.days.flatMap((d) => d.rows);
  eq(
    rows.map((r) => r.kind),
    ['bill'],
    'the Individual view has no warning rows either'
  );
  eq(rows[0].code, 'Proj', 'the line is coded by project');
  // Five back-to-back 1h entries combine into one 5h line under an 8h cap.
  eq(rows[0].rounded, 5 * 3600, 'adjacent same-project entries combine into one line');
}

{
  // The billable cap still splits the run, here after the fourth hour.
  const week = buildIndividualWeek({ ...byProject, maxBillableHours: 4 })!;
  eq(
    week.days.flatMap((d) => d.rows).map((r) => r.rounded),
    [4 * 3600, 3600],
    'the billable cap still splits a combined projects-only line'
  );
}

{
  // A project with a blank stored name (possible once archived) bills as its
  // id in both views.
  const nameless = { ...base, entries: [entry(1, 8, 1, 'D1', 'a')], projects: [{ id: 1, name: '' }], billByProject: true };
  eq(
    buildSummaryGrid(nameless)!.rowMeta.get('p1|#1')!.tag,
    '#1',
    'a nameless project bills to its id rather than to an empty line'
  );
  eq(
    buildIndividualWeek({ ...nameless, maxBillableHours: 8 })!.days[0].rows[0].code,
    '#1',
    'and the Individual view uses the same fallback'
  );
}

{
  // Export contract for a projects-only sheet, which templates rely on:
  // `billingCode` equals `project` on every row and neither is blank, including
  // for a nameless project.
  const range = { fromMs: WEEK, toMs: WEEK + 7 * 24 * 3600e3 };
  const docOpts = {
    range,
    entries: mixed,
    nowMs: base.nowMs,
    multi: true,
    maxBillableHours: 8,
    billingTagPrefix: 'D',
    roundingSeconds: 900,
    noOvertime: false,
    weeklyHours: 40,
    billByProject: true,
    title: 'T',
    personName: 'P',
  };
  const views: ('summary' | 'individual')[] = ['summary', 'individual'];
  // A named project and a nameless one.
  const projectSets: { id: number; name: string }[][] = [[{ id: 1, name: 'Proj' }], [{ id: 1, name: '' }]];
  for (const view of views) {
    for (const projects of projectSets) {
      const doc = buildExportDoc({ ...docOpts, view, projects });
      // `label` (summary) and `code` (individual) are the billing column text.
      const rows =
        doc.view === 'summary'
          ? doc.weeks.flatMap((w) => w.rows.map((r) => ({ ...r, shown: r.label })))
          : doc.days.flatMap((d) => d.rows.map((r) => ({ ...r, shown: r.code })));
      ok(rows.length > 0, `${view}: the projects-only document has rows`);
      for (const r of rows) {
        eq(r.billingCode, r.project, `${view}: billingCode equals project ("${r.billingCode}")`);
        ok(r.project !== '', `${view}: the project field is never blank`);
        // multi is true above, so this also pins the no-prefix rule.
        eq(r.shown, r.billingCode, `${view}: the billing column carries no project prefix`);
      }
    }
  }
}

{
  // The overtime cap still trims, with no "(X)" or "(!)" shares.
  const grid = buildSummaryGrid({ ...byProject, noOvertime: true, weeklyHours: 3 })!;
  eq(grid.grandTotal, 3 * 3600, 'the weekly cap still trims a projects-only sheet');
  eq(grid.overtimeTotal, 2 * 3600, 'and reports what it took off');
}

console.log(`✓ ${checks} billing-code checks passed`);
