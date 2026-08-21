// Content checks for the report PDF template. Run with:
//   npm run check:report
//
// These assert on the pdfmake *document definition* — the tree of text the
// template emits — rather than on a rendered PDF. That is where every claim the
// document makes to a client lives: the amounts, the totals they must add up
// to, the locale conventions, and the caps that keep unbounded Toggl text from
// running off the page.
//
// The template imports through the `@/` alias, so resolution is patched in
// before the dynamic import below.

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

const { reportTemplates } = await import('../lib/export/pdf/report.ts');

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};
const no = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(!cond, msg);
};

// ---- fixtures ----

const D = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime();

interface RowSpec {
  s: [number, number];
  e: [number, number];
  code: string;
  project: string;
  desc: string;
}

function day(dateMs: number, specs: RowSpec[]) {
  const rows = specs.map((r) => {
    const startMs = dateMs + r.s[0] * 3600e3 + r.s[1] * 60e3;
    const endMs = dateMs + r.e[0] * 3600e3 + r.e[1] * 60e3;
    return {
      // Deliberately wrong: the device-locale string must never reach the page.
      time: '09:30 AM–12:00 PM',
      startMs,
      endMs,
      hours: Math.round((endMs - startMs) / 1000),
      code: r.code,
      billingCode: r.code,
      project: r.project,
      warn: false,
      desc: r.desc,
    };
  });
  return { dateMs, label: '', total: rows.reduce((s, r) => s + r.hours, 0), rows };
}

// 18.75 h across three billing codes at 1125/h = 21 093.75 — a fractional
// amount of exactly the kind the old whole-unit formatting rounded away.
const TOTAL_HOURS = 18.75;
const TOTAL_FEE_CS = /21 093,75/;
const TOTAL_FEE_EN = /21,093\.75/;
const DAYS = [
  day(D(2026, 7, 1), [
    { s: [9, 30], e: [12, 0], code: 'BC-100', project: 'Alpha Platform', desc: 'Design session' },
    { s: [15, 30], e: [16, 15], code: 'BC-200', project: 'Alpha Platform', desc: 'Backlog review' },
  ]),
  day(D(2026, 7, 2), [
    { s: [7, 45], e: [9, 30], code: 'BC-200', project: 'Alpha Platform', desc: 'Integration spec' },
    { s: [18, 0], e: [21, 30], code: 'BC-300', project: 'Alpha Platform', desc: 'Ticket triage' },
  ]),
  day(D(2026, 7, 14), [
    { s: [6, 0], e: [10, 0], code: 'BC-200', project: 'Alpha Platform', desc: 'Infrastructure update' },
    { s: [12, 0], e: [15, 30], code: 'BC-200', project: 'Alpha Platform', desc: 'Infrastructure update' },
    { s: [16, 0], e: [18, 45], code: 'BC-200', project: 'Alpha Platform', desc: 'Architecture alignment' },
  ]),
];

const baseDoc = {
  view: 'individual' as const,
  title: 'Alpha Platform',
  personName: 'Jan Novák',
  role: 'Solutions Architect',
  company: 'IGNORED — the report must not print the supplier company',
  client: 'Example Client s.r.o.',
  approver: 'Jana Nováková, Head of Delivery',
  reference: 'TS-2026-07',
  rate: 1125,
  currency: 'CZK',
  fromMs: D(2026, 7, 1),
  toMs: D(2026, 8, 1),
  multi: false,
  days: DAYS,
  grandTotal: DAYS.reduce((s, d) => s + d.total, 0),
};

const build = (id: 'report-en' | 'report-cs', over: Record<string, unknown> = {}) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reportTemplates.find((t) => t.id === id)!.build({ ...baseDoc, ...over } as any);

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

// Intl groups Czech thousands with a non-breaking space, and Czech puts one
// before the percent sign; normalise that family so the assertions below can
// be written with an ordinary space.
const NBSP = /[\u00a0\u202f\u2009]/g;
const allText = (def: unknown) => texts(def).join(' ').replace(NBSP, ' ');

// ---- the amount must not be silently rounded away ----

{
  const cs = allText(build('report-cs'));
  const en = allText(build('report-en'));
  // The old template rounded to whole units and would have printed 21 094.
  ok(TOTAL_FEE_CS.test(cs), 'CZ report prints 21 093,75 — the fraction survives');
  no(/21 094(?!,)/.test(cs), 'CZ report never prints the rounded-up 21 094');
  ok(TOTAL_FEE_EN.test(en), 'EN report prints 21,093.75');
  no(/21,094(?!\.)/.test(en), 'EN report never prints the rounded-up 21,094');
  ok(cs.includes('18,75'), `CZ report states ${TOTAL_HOURS} h with a decimal comma`);
}

// ---- printed columns add up ----

/** Pull the fee column out of a table whose header contains `header`. */
function tableRows(def: any, headerText: string): any[][] {
  const found: any[][] = [];
  const walk = (n: any) => {
    if (n == null || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.table?.body) {
      const head = texts(n.table.body[0]).join(' ');
      if (head.includes(headerText)) found.push(n.table.body);
    }
    Object.values(n).forEach((v) => typeof v !== 'function' && walk(v));
  };
  walk(def);
  return found;
}

const parseCs = (s: string) => Number(s.replace(/[^\d,-]/g, '').replace(',', '.'));

for (const currency of ['CZK', 'EUR', 'USD', 'JPY', 'KWD', 'HUF']) {
  for (const rate of [1125, 95.5, 1234.5678, 0.07, 18500]) {
    const def = build('report-cs', { currency, rate });
    for (const header of ['PODÍL', 'KÓD PROJEKT']) {
      const bodies = tableRows(def, header);
      ok(bodies.length === 1, `one ${header} table for ${currency}@${rate}`);
      const body = bodies[0];
      const feeCol = texts(body[0]).length - 1; // fees is the last column
      const dataRows = body.slice(1, -1);
      const totalRow = body[body.length - 1];
      const sum = dataRows.reduce((s, r) => s + parseCs(texts(r[feeCol]).join('')), 0);
      const total = parseCs(texts(totalRow[totalRow.length - 1]).join(''));
      ok(
        Math.abs(sum - total) < 1e-9,
        `${header} fee rows sum to the total for ${currency}@${rate} (${sum} vs ${total})`
      );
    }
  }
}

// MD and share columns must total too.
{
  const def = build('report-cs');
  const body = tableRows(def, 'PODÍL')[0];
  const mdCol = 2;
  const shareCol = 3;
  const rows = body.slice(1, -1);
  const totalRow = body[body.length - 1];
  const mdSum = rows.reduce((s, r) => s + parseCs(texts(r[mdCol]).join('')), 0);
  ok(
    Math.abs(mdSum - parseCs(texts(totalRow[mdCol]).join(''))) < 1e-9,
    'MD column sums to the MD total'
  );
  const shareSum = rows.reduce((s, r) => s + parseCs(texts(r[shareCol]).join('')), 0);
  ok(shareSum === 100, `shares sum to 100 (got ${shareSum})`);
}

// Shares still total 100 when they do not divide evenly.
{
  const thirds = [
    day(D(2026, 7, 1), [{ s: [9, 0], e: [10, 0], code: 'A', project: 'Alpha', desc: 'x' }]),
    day(D(2026, 7, 2), [{ s: [9, 0], e: [10, 0], code: 'B', project: 'Beta', desc: 'x' }]),
    day(D(2026, 7, 3), [{ s: [9, 0], e: [10, 0], code: 'C', project: 'Gamma', desc: 'x' }]),
  ];
  const def = build('report-en', {
    days: thirds,
    grandTotal: thirds.reduce((s, d) => s + d.total, 0),
  });
  const body = tableRows(def, 'SHARE')[0];
  const rows = body.slice(1, -1);
  const shares = rows.map((r) => parseInt(texts(r[3]).join(''), 10));
  ok(
    shares.reduce((a, b) => a + b, 0) === 100,
    `three equal projects still share out to 100 (${shares.join('+')})`
  );
}

// ---- currency edge cases ----

{
  const jpy = allText(build('report-en', { currency: 'JPY', rate: 18500 }));
  no(/¥[\d,]+\.\d/.test(jpy), 'JPY amounts carry no decimals');
  const kwd = allText(build('report-en', { currency: 'KWD', rate: 42.375 }));
  ok(/\d\.\d{3}\b/.test(kwd), 'KWD amounts carry three decimals');
  // Garbage the user can type into a 3-character box.
  for (const bad of ['Kč', 'CZ', '12', '']) {
    const t = allText(build('report-cs', { currency: bad, rate: 1125 }));
    ok(TOTAL_FEE_CS.test(t), `currency "${bad}" still shows the right amount`);
  }
  // A code Intl accepts but does not know still labels the amount.
  ok(
    allText(build('report-en', { currency: 'XBT', rate: 1125 })).includes('XBT'),
    'an unknown-but-well-formed code is printed alongside the amount'
  );
}

// A time-only report must mention no money at all.
{
  const t = allText(build('report-cs', { rate: null, currency: '' }));
  no(/Kč|CZK|Cena|Částka|Fakturace/.test(t), 'a rate-less CZ report carries no money wording');
  ok(t.includes('Potvrzení a schválení'), 'a rate-less CZ report uses the plain sign-off title');
}

// ---- Czech conventions ----

{
  const cs = allText(build('report-cs'));
  no(/\bAM\b|\bPM\b/.test(cs), 'the CZ report never prints AM/PM, whatever the device locale is');
  no(cs.includes('09:30 AM–12:00 PM'), 'the device-locale time string never reaches the CZ page');
  ok(cs.includes('9:30–12:00'), 'CZ times are 24-hour with no leading zero');
  ok(/18,75/.test(cs), 'CZ decimals use a comma');
  no(/18\.75/.test(cs), 'CZ decimals never use a point');
  ok(/100 %|100 %/.test(cs), 'CZ puts a space before the percent sign');
  ok(cs.includes('1. 7. – 31. 7. 2026'), 'CZ date range uses day. month. year');
  // "Odměna" is contract-law wording, not what a Czech timesheet annex says.
  no(/[Oo]dměn/.test(cs), 'the CZ report has dropped "odměna"');
  ok(/Cena|Částka|Fakturace/.test(cs), 'the CZ report uses standard invoicing wording');
}

{
  const en = allText(build('report-en'));
  ok(en.includes('09:30–12:00'), 'EN (en-GB) times are 24-hour, zero-padded');
  no(/\bAM\b|\bPM\b/.test(en), 'the EN report is 24-hour too, matching its en-GB locale');
}

// ---- MD is a first-class quantity ----

// 18.75 h / 8 = 2.34375, printed to two places as 2.34 / 2,34.
for (const id of ['report-en', 'report-cs'] as const) {
  const def = build(id);
  const t = allText(def);
  const md = id === 'report-cs' ? '2,34' : '2.34';
  ok(t.includes(md), `${id} states the period MD (${md})`);
  ok(/\bMD\b/.test(t), `${id} labels the MD unit`);
  ok(/1 MD = 8 h/.test(t), `${id} states the man-day basis under the summary tables`);
  ok(
    /8 hours|8 hodinám/.test(t),
    `${id} restates the man-day basis in the basis-of-preparation note`
  );
  const projBody = tableRows(def, id === 'report-cs' ? 'PODÍL' : 'SHARE')[0];
  ok(texts(projBody[0]).includes('MD'), `${id} by-project table has an MD column`);
  const codeBody = tableRows(def, id === 'report-cs' ? 'KÓD PROJEKT' : 'CODE PROJECT')[0];
  ok(texts(codeBody[0]).includes('MD'), `${id} by-code table has an MD column`);
  // The cover states effort in both units.
  ok(
    t.includes(`${md} MD`),
    `${id} quotes hours and MD together on the cover`
  );
}

// ---- an MD-rate engagement speaks in man-days everywhere ----

// 18.75 h = 2.34375 MD; at 9 000/MD the total is the hourly fixture's
// 21 093.75 again, so the amount patterns carry over unchanged.
{
  const cs = allText(build('report-cs', { rate: 9000, rateBasis: 'md' }));
  ok(TOTAL_FEE_CS.test(cs), 'CZ MD-rate report prices the man-days correctly');
  ok(cs.includes('/MD'), 'CZ MD-rate report quotes the rate per MD');
  no(cs.includes('/h'), 'CZ MD-rate report never quotes a per-hour rate');
  ok(cs.includes('sjednané sazby za MD'), 'CZ fees note speaks of the MD rate');
  ok(cs.includes('při sjednané sazbě za MD'), 'CZ declaration speaks of the MD rate');
  no(cs.includes('hodinové saz'), 'CZ MD-rate report never mentions an hourly rate');
  ok(cs.includes('2,34 MD ×'), 'CZ fee breakdown multiplies man-days, not hours');

  const en = allText(build('report-en', { rate: 9000, rateBasis: 'md' }));
  ok(TOTAL_FEE_EN.test(en), 'EN MD-rate report prices the man-days correctly');
  ok(en.includes('/MD'), 'EN MD-rate report quotes the rate per MD');
  no(en.includes('/h'), 'EN MD-rate report never quotes a per-hour rate');
  ok(en.includes('agreed MD rate'), 'EN fees note and declaration speak of the MD rate');
  no(en.includes('hourly rate'), 'EN MD-rate report never mentions an hourly rate');
  ok(en.includes('2.34 MD ×'), 'EN fee breakdown multiplies man-days, not hours');

  // The hourly wording is untouched — and an absent basis still means hourly.
  const hourly = allText(build('report-cs'));
  ok(hourly.includes('/h'), 'an hourly report still quotes the rate per hour');
  no(hourly.includes('/MD'), 'an hourly report never quotes a per-MD rate');
  ok(hourly.includes('hodinové sazby'), 'the hourly fees note is unchanged');
}

// MD-basis fee columns must still sum to their printed totals.
{
  const def = build('report-cs', { rate: 9000, rateBasis: 'md' });
  for (const header of ['PODÍL', 'KÓD PROJEKT']) {
    const body = tableRows(def, header)[0];
    const feeCol = texts(body[0]).length - 1;
    const dataRows = body.slice(1, -1);
    const totalRow = body[body.length - 1];
    const sum = dataRows.reduce((s, r) => s + parseCs(texts(r[feeCol]).join('')), 0);
    const total = parseCs(texts(totalRow[totalRow.length - 1]).join(''));
    ok(
      Math.abs(sum - total) < 1e-9,
      `${header} MD-basis fee rows sum to the total (${sum} vs ${total})`
    );
  }
}

// ---- the reference is the user's, not a derived constant ----

{
  const t = allText(build('report-en', { reference: 'PO-4471/2026' }));
  ok(t.includes('PO-4471/2026'), 'a user-supplied reference is used');
  no(t.includes('TS-2026-07'), 'the derived reference does not leak alongside it');
  const derived = allText(build('report-en', { reference: '' }));
  ok(derived.includes('TS-2026-07'), 'an empty reference falls back to the period default');
}

// ---- the engagement note ----

{
  const note =
    'Prepared under the Master Services Agreement of 1 March 2024 and order 2024/117, ' +
    'end customer Example End Customer GmbH.';
  for (const id of ['report-en', 'report-cs'] as const) {
    const t = allText(build(id, { engagement: note }));
    ok(t.includes(note), `${id} prints the engagement note word for word`);
    // It leads the basis block, and the standing wording still follows it.
    const basisAt = t.indexOf(id === 'report-cs' ? 'ZPŮSOB VYKAZOVÁNÍ' : 'BASIS OF PREPARATION');
    ok(basisAt >= 0, `${id} still has a basis block`);
    ok(t.indexOf(note) > basisAt, `${id} puts the note inside the basis block`);
    ok(
      t.indexOf(id === 'report-cs' ? 'Každý řádek' : 'Each line') > t.indexOf(note),
      `${id} keeps the standing wording after the note`
    );
  }
  // Without a note the document still reads correctly.
  const bare = allText(build('report-en', { engagement: '' }));
  ok(bare.includes('Each line carries'), 'an empty note leaves the standing wording intact');
  // An over-long note is capped rather than pushing the box off the page.
  const huge = allText(build('report-en', { engagement: 'Under annex 3, '.repeat(200) }));
  ok(
    texts(build('report-en', { engagement: 'Under annex 3, '.repeat(200) })).every(
      (x) => !x.startsWith('Under annex 3') || x.length <= 700
    ),
    'a runaway engagement note is clamped'
  );
  void huge;
}

// ---- nothing client-facing may leak internal vocabulary ----

for (const id of ['report-en', 'report-cs'] as const) {
  const t = allText(build(id));
  for (const word of ['Toggl', 'toggl', 'tracker', 'on screen', 'in the app', 'v aplikaci']) {
    no(t.includes(word), `${id} does not say "${word}" to the client`);
  }
}

// ---- Czech signature lines carry both gendered endings ----

{
  const t = allText(build('report-cs'));
  ok(t.includes('Zpracoval(a)'), 'CZ prepared-by covers either signer');
  ok(t.includes('Schválil(a)'), 'CZ approved-by covers either signer');
  ok(t.includes('ZPRACOVAL(A)'), 'the CZ cover label does too');
}

// ---- the supplier company is genuinely unused by this template ----

{
  const t = allText(build('report-en', { company: 'ZZTOPSECRETCOMPANYZZ' }));
  no(t.includes('ZZTOPSECRETCOMPANYZZ'), 'the report prints no company field');
  ok(
    !reportTemplates.some((tpl) => tpl.fields?.includes('company')),
    'so the report templates no longer ask for one'
  );
  // With no client given, the title stands in — the company must not.
  const fallback = allText(build('report-en', { client: '', company: 'ZZTOPSECRETCOMPANYZZ' }));
  no(fallback.includes('ZZTOPSECRETCOMPANYZZ'), 'company is not a silent client fallback either');
  ok(fallback.includes('Alpha Platform'), 'the document title stands in for a missing client');
}

// ---- unbounded text is capped before it can break the page ----

{
  const huge = 'Detailed handover write-up covering the migration plan. '.repeat(200); // ~11k chars
  const longProject = 'Programme Alpha — Customer Identity and Access Management '.repeat(6);
  const longCode = 'CODE-ALPHA-0001-EXTENDED-IDENTIFIER-THAT-KEEPS-GOING-AND-GOING'.repeat(3);
  const longClient = 'Příliš žluťoučký kontrolní a metodický úřad pro standardizaci '.repeat(10);
  const days = [
    day(D(2026, 7, 6), [
      { s: [8, 0], e: [16, 0], code: longCode, project: longProject, desc: huge },
    ]),
  ];
  const def = build('report-cs', {
    days,
    grandTotal: days.reduce((s, d) => s + d.total, 0),
    client: longClient,
    personName: 'Jan Maxmilián Nepomucký '.repeat(20),
    role: 'Principal Solutions Architect '.repeat(10),
    approver: 'Ing. Jana Nováková, Ph.D., MBA '.repeat(10),
    reference: 'PO-4471-2026/EXAMPLE-CLIENT/ALPHA-PLATFORM-PHASE-TWO-EXTENDED',
  });
  const longest = texts(def).reduce((a, b) => (a.length >= b.length ? a : b));
  // The basis-of-preparation paragraph is the longest legitimate fixed string.
  ok(
    longest.length <= 750,
    `no single text run exceeds the day-log cap (longest was ${longest.length} chars)`
  );
  for (const t of texts(def)) {
    ok(
      !t.startsWith('Detailed handover') || t.length <= 700,
      'the pathological description is clamped to its cap'
    );
  }
  ok(
    texts(def).some((t) => t.includes('…')),
    'clamped values are marked with an ellipsis rather than silently cut'
  );
  // The client name is never truncated — it is who the document is for.
  const cover = texts(def)[3] ?? '';
  void cover;
  ok(
    texts(def).some((t) => t.startsWith('Příliš žluťoučký') && t.length > 120),
    'the client name keeps its length (the cover type shrinks instead)'
  );
}

// A many-project cover must summarise rather than run on.
{
  const specs = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'].map((p, i) => ({
    s: [8 + i, 0] as [number, number],
    e: [9 + i, 0] as [number, number],
    code: `C-${i}`,
    project: p,
    desc: 'x',
  }));
  const days = [day(D(2026, 7, 6), specs)];
  const en = allText(
    build('report-en', { days, grandTotal: days.reduce((s, d) => s + d.total, 0), multi: true })
  );
  ok(en.includes('+4 more'), 'the cover lists three projects and counts the rest');
  const cs = allText(
    build('report-cs', { days, grandTotal: days.reduce((s, d) => s + d.total, 0), multi: true })
  );
  ok(cs.includes('+4 další'), 'the Czech count declines the numeral correctly (2–4 → další)');
}

// ---- an empty period must still produce a coherent document ----

{
  const def = build('report-cs', { days: [], grandTotal: 0, rate: 1125 });
  const t = allText(def);
  ok(t.includes('0 h'), 'an empty period reports zero hours');
  ok(/0,00/.test(t), 'an empty period reports a zero amount, not NaN');
  no(/NaN|Infinity|undefined/.test(t), 'no NaN / Infinity / undefined anywhere');
}

// No fixture may ever leak these.
for (const id of ['report-en', 'report-cs'] as const) {
  for (const over of [{}, { rate: null }, { currency: 'JPY' }, { days: [], grandTotal: 0 }]) {
    const t = allText(build(id, over));
    no(/NaN|Infinity|undefined|\[object/.test(t), `${id} ${JSON.stringify(over)}: clean output`);
  }
}

console.log(`✓ ${checks} report content checks passed`);
