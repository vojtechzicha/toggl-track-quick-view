// Content checks for the Timesheet Acceptance Protocol PDF template (both
// variants). Run with:
//   npm run check:acceptance
//
// Like check-report.ts, these assert on the pdfmake *document definition* the
// template emits. The load-bearing claims: the Compact variant only rewrites
// the Project / Task cell (Hours and MD columns stay byte-identical to Full),
// and the compact aggregation follows its spec — per-tag groups by descending
// hours, dominance, support-ticket and meetings collapsing, text hygiene.

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

const { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID, getTemplate } = await import(
  '../lib/export/pdf/templates.ts'
);
const { compactDayText, fixDescTypos } = await import('../lib/export/pdf/acceptanceCompact.ts');

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepEqual(a, b, msg);
};
const no = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(!cond, msg);
};

// ---- fixtures ----

const D = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();
const H = (h: number) => Math.round(h * 3600);

interface RowSpec {
  code: string;
  desc: string;
  h: number;
}

/** An IndividualDayBlock with the fields the acceptance template reads. */
function day(dateMs: number, specs: RowSpec[]) {
  const rows = specs.map((r, i) => ({
    time: null,
    startMs: dateMs + (8 + i) * 3600e3,
    endMs: dateMs + (9 + i) * 3600e3,
    hours: H(r.h),
    code: r.code,
    billingCode: r.code,
    project: 'J&T Banka',
    warn: false,
    desc: r.desc,
  }));
  return { dateMs, label: '', total: rows.reduce((s, r) => s + r.hours, 0), rows };
}

// Mirrors the real July 2026 data the variant was specified against.
const DAYS = [
  // 7/7 — a meetings tag whose entries carry no "Meeting | " prefix.
  day(D(2026, 7, 7), [
    { code: 'J-CLD-249 (Cloud - schůzky)', desc: 'Cloud: stand-up', h: 0.4 },
    { code: 'J-CLD-899 (AVD pentesty)', desc: 'příprava scénářů pro AVD penetrační test', h: 3.2 },
    { code: 'J-CLD-249 (Cloud - schůzky)', desc: '1:1 Michaela/Vojta', h: 0.8 },
    { code: 'J-MDS-1', desc: 'PMDP-81 studium dodaných podkladů', h: 1.0 },
  ]),
  // 14/7 — the typo day ("poklady" → "podklady" in both variants).
  day(D(2026, 7, 14), [
    { code: 'J-CLD-900 (Assety fáze 2)', desc: 'úprava zápisu a poklady pro OBE, meeting s OBE', h: 6.2 },
    { code: 'J-CRM', desc: 'Meeting | Trans. projekty - sladění (cloud)', h: 1.0 },
  ]),
  // 15/7 — the spec's worked example.
  day(D(2026, 7, 15), [
    { code: 'J-CLD-450 (Cloud - sběrný ticket)', desc: 'finalizace Cloud konceptu', h: 2.4 },
    {
      code: 'J-CLD-900 (Assety fáze 2)',
      desc: 'Assets - PSD2 koncept a zajištění syncu s bezpečností',
      h: 2.8,
    },
    { code: 'ITSD-214020', desc: 'vygenerování a předání klíče', h: 1.2 },
    { code: 'ITSD-211968', desc: 'vygenerování a předání klíče', h: 0.6 },
    { code: 'J-CLD-919 (AI reporting)', desc: 'finalizace AI reporting konceptu', h: 0.8 },
  ]),
  // 16/7 — a ticket description declaring more tickets behind it.
  day(D(2026, 7, 16), [
    { code: 'J-CLD-919 (AI reporting)', desc: 'finalizace AI reporting konceptu', h: 0.6 },
    {
      code: 'ITSD-212604',
      desc: 'vygenerování a předání klíče (+ řešení 7 obdobných ticketů)',
      h: 2.6,
    },
    { code: 'J-CLD-450 (Cloud - sběrný ticket)', desc: 'finalizace Cloud konceptu', h: 3.2 },
  ]),
];

const baseDoc = {
  view: 'individual' as const,
  title: 'J&T Banka',
  personName: 'Vojtěch Zicha',
  role: 'Solutions Architect',
  company: 'Deloitte',
  client: '',
  approver: '',
  reference: '',
  engagement: '',
  rate: null,
  currency: '',
  fromMs: D(2026, 7, 1),
  toMs: D(2026, 8, 1),
  multi: false,
  days: DAYS,
  grandTotal: DAYS.reduce((s, d) => s + d.total, 0),
};

const build = (id: string, over: Record<string, unknown> = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTemplate(id).build({ ...baseDoc, ...over } as any);

/** Every `text` string anywhere in a pdfmake definition, in document order. */
function texts(node: unknown, out: string[] = []): string[] {
  if (node == null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) texts(n, out);
    return out;
  }
  const o = node as Record<string, unknown>;
  if (typeof o.text === 'string') out.push(o.text);
  else if (Array.isArray(o.text)) texts(o.text, out);
  for (const [k, v] of Object.entries(o)) {
    if (k === 'text' || typeof v === 'function') continue;
    texts(v, out);
  }
  return out;
}

/** The day table's body rows (skipping the header), as arrays of cell texts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dayRows(def: any): string[][] {
  const found: string[][][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any) => {
    if (n == null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.table?.body && texts(n.table.body[0]).join(' ').includes('Project / Task')) {
      found.push(n.table.body.map((row: unknown[]) => row.map((c) => texts(c).join(''))));
    }
    Object.values(n).forEach((v) => typeof v !== 'function' && walk(v));
  };
  walk(def);
  ok(found.length === 1, 'exactly one day table');
  return found[0].slice(1);
}

const TASK = 5; // day-table column indices
const HOURS = 6;
const MDS = 7;
const rowFor = (rows: string[][], dm: string) => rows.find((r) => r[3] === dm)!;

// ---- registry ----

{
  const full = PDF_TEMPLATES.find((t) => t.id === 'acceptance-protocol');
  const compact = PDF_TEMPLATES.find((t) => t.id === 'acceptance-protocol-compact');
  ok(full && full.name.includes('(Full)'), 'the original id remains, renamed "(Full)"');
  ok(compact && compact.name.includes('(Compact)'), 'the compact variant is registered');
  eq(compact?.fields, full?.fields, 'both variants ask for the same identity fields');
  ok(DEFAULT_TEMPLATE_ID === 'standard', 'the default template is unchanged');
}

const fullDef = build('acceptance-protocol');
const compactDef = build('acceptance-protocol-compact');
const fullRows = dayRows(fullDef);
const compactRows = dayRows(compactDef);

// ---- the variants differ ONLY in the task cell ----

{
  eq(fullRows.length, 31, 'every calendar day of July appears (Full)');
  eq(compactRows.length, 31, 'every calendar day of July appears (Compact)');
  eq(
    compactRows.map((r) => r[HOURS]),
    fullRows.map((r) => r[HOURS]),
    'the Hours column is byte-identical between variants'
  );
  eq(
    compactRows.map((r) => r[MDS]),
    fullRows.map((r) => r[MDS]),
    'the MDs column is byte-identical between variants'
  );
  const header = (def: unknown) => texts(def).join('\n').split('Year')[0];
  eq(header(compactDef), header(fullDef).replace(/\(Full\)|\(Compact\)/g, ''), // names differ nowhere on-page
    'the header block (name/role/company/MDs) is identical');
  const empty = (rows: string[][]) => rows.filter((r) => r[TASK] === '').length;
  eq(empty(compactRows), empty(fullRows), 'zero-days stay empty in both variants');
}

// ---- the spec's worked example (15/7) ----

{
  eq(
    rowFor(compactRows, '15/7')[TASK],
    'J-CLD-900 – Assets - PSD2 koncept a zajištění syncu s bezpečností (2.8 h); ' +
      'J-CLD-450 – finalizace Cloud konceptu (2.4 h); ' +
      'Support – ITSD-214020, ITSD-211968 (1.8 h); ' +
      'J-CLD-919 – finalizace AI reporting konceptu (0.8 h)',
    '15/7 renders exactly per the compact spec'
  );
  const full = rowFor(fullRows, '15/7')[TASK];
  ok(
    full.includes('J-CLD-450 (Cloud - sběrný ticket) - finalizace Cloud konceptu'),
    'the Full variant still lists rows verbatim'
  );
  eq(rowFor(compactRows, '15/7')[HOURS], '7.80', 'the grouping never changes the day total');
}

// ---- support tickets ----

{
  const t = rowFor(compactRows, '16/7')[TASK];
  ok(
    t.includes('Support – ITSD-212604 a další (2.6 h)'),
    '"+ řešení 7 obdobných ticketů" appends "a další"'
  );
  ok(t.startsWith('J-CLD-450'), 'groups are ordered by descending hours');
  // A directly-tagged support row (no ticket-code fallback) still collapses.
  const tagged = compactDayText([
    { code: '.J-Support', desc: '[ITSD-1] oprava; [ITSD-2] konfigurace', seconds: H(1.4) },
  ]);
  eq(tagged, 'Support – ITSD-1, ITSD-2 (1.4 h)', 'a ".J-Support" tag groups by tickets from the text');
}

// ---- meetings collapse ----

{
  const t = rowFor(compactRows, '7/7')[TASK];
  ok(t.includes('J-CLD-249 – schůzky (1.2 h)'), 'the meetings tag collapses to "schůzky"');
  for (const name of ['stand-up', '1:1', 'retro']) {
    no(t.includes(name), `no individual meeting name ("${name}") leaks into Compact`);
  }
  ok(
    rowFor(fullRows, '7/7')[TASK].includes('Cloud: stand-up'),
    'the Full variant keeps the meeting names'
  );
  // Non-meeting tags merely lose the "Meeting | " prefix.
  const crm = rowFor(compactRows, '14/7')[TASK];
  ok(crm.includes('J-CRM – Trans. projekty - sladění (cloud)'), 'the "Meeting | " prefix is stripped');
  no(crm.includes('Meeting |'), 'no prefix survives in Compact');
}

// ---- text hygiene, in both variants ----

{
  for (const [name, rows] of [
    ['Full', fullRows],
    ['Compact', compactRows],
  ] as const) {
    const t = rowFor(rows, '14/7')[TASK];
    ok(t.includes('podklady pro OBE'), `${name} fixes "poklady" → "podklady"`);
    no(/\bpoklady\b/.test(t), `${name} carries no bare "poklady"`);
  }
  eq(fixDescTypos('Fnalizace a defnice podkladů'), 'Finalizace a definice podkladů',
    'typo fixes preserve capitalisation and leave the correct word alone');
}

// ---- dominance and the top-two rule ----

{
  // 75% dominates: only the dominant description shows.
  const dominant = compactDayText([
    { code: 'J-TEST-1', desc: 'hlavní práce na konceptu', seconds: H(3.0) },
    { code: 'J-TEST-1', desc: 'vedlejší úkol', seconds: H(1.0) },
  ]);
  eq(dominant, 'J-TEST-1 – hlavní práce na konceptu (4.0 h)', 'a ≥70% description stands alone');
  // 56% does not: the top two carry the group.
  const split = compactDayText([
    { code: 'J-TEST-1', desc: 'hlavní práce na konceptu', seconds: H(2.0) },
    { code: 'J-TEST-1', desc: 'vedlejší úkol', seconds: H(1.6) },
  ]);
  eq(
    split,
    'J-TEST-1 – hlavní práce na konceptu + vedlejší úkol (3.6 h)',
    'below 70% the top two descriptions join with " + "'
  );
  // Identical descriptions across rows appear once (and pool their hours).
  const dedup = compactDayText([
    { code: 'J-TEST-1', desc: 'stejná práce', seconds: H(1.0) },
    { code: 'J-TEST-1', desc: 'Stejná práce', seconds: H(1.0) },
    { code: 'J-TEST-1', desc: 'jiná drobnost', seconds: H(0.4) },
  ]);
  eq(dedup, 'J-TEST-1 – stejná práce (2.4 h)', 'duplicate descriptions dedupe into one');
  // An overlong dominant description is cut at a word boundary and marked.
  const long = compactDayText([
    {
      code: 'J-TEST-1',
      desc: 'velmi dlouhý popis práce který se rozhodně nevejde do padesáti znaků ani omylem',
      seconds: H(1.0),
    },
  ]);
  const summary = long.slice('J-TEST-1 – '.length, -' (1.0 h)'.length);
  ok(summary.endsWith('…'), 'an overlong summary is marked with an ellipsis');
  ok(summary.length <= 60, `an overlong summary is clamped (got ${summary.length} chars)`);
  no(summary.includes('padesáti'), 'the tail of an overlong summary is dropped');
}

// ---- untagged rows ----

{
  const t = compactDayText([
    { code: '', desc: 'nezařazená práce', seconds: H(0.6) },
    { code: 'J-TEST-1', desc: 'práce', seconds: H(1.0) },
  ]);
  eq(t, 'J-TEST-1 – práce (1.0 h); Ostatní – nezařazená práce (0.6 h)',
    'rows without a tag group under "Ostatní"');
}

// ---- the summary view feeds the same aggregation ----

{
  const weekStart = D(2026, 7, 4); // Saturday before 6/7
  const dayDates = [D(2026, 7, 6), D(2026, 7, 7)];
  const mk = (label: string, cells: number[], dayDescs: string[]) => ({
    label,
    billingCode: label,
    project: 'J&T Banka',
    warn: false,
    cells,
    desc: dayDescs.filter(Boolean).join('; '),
    dayDescs,
    total: cells.reduce((s, v) => s + v, 0),
  });
  const rows = [
    mk('J-CLD-249 (Cloud - schůzky)', [H(0.6), H(1.2)], ['Cloud: stand-up', 'Cloud: stand-up; 1:1']),
    mk('J-CLD-900 (Assety fáze 2)', [H(6.4), 0], ['Assets - koncept', '']),
  ];
  const doc = {
    ...baseDoc,
    view: 'summary' as const,
    weeks: [
      {
        weekStart,
        label: '',
        dayLabels: ['Mon', 'Tue'],
        dayDates,
        rows,
        dayTotals: dayDates.map((_, ci) => rows.reduce((s, r) => s + r.cells[ci], 0)),
        grandTotal: rows.reduce((s, r) => s + r.total, 0),
      },
    ],
    grandTotal: rows.reduce((s, r) => s + r.total, 0),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { days: _days, ...summaryDoc } = doc as any;
  const rows6 = dayRows(getTemplate('acceptance-protocol-compact').build(summaryDoc));
  eq(
    rowFor(rows6, '6/7')[TASK],
    'J-CLD-900 – Assets - koncept (6.4 h); J-CLD-249 – schůzky (0.6 h)',
    'a summary-view export groups by row label per day'
  );
  eq(rowFor(rows6, '7/7')[TASK], 'J-CLD-249 – schůzky (1.2 h)', 'per-day cells stay per-day');
}

// ---- nothing may leak ----

for (const def of [fullDef, compactDef]) {
  const t = texts(def).join(' ');
  no(/NaN|Infinity|undefined|\[object/.test(t), 'clean output — no NaN / undefined');
}

console.log(`✓ ${checks} acceptance content checks passed`);
