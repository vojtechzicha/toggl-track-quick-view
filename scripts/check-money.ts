// Invariant checks for the PDF money/allocation primitives. Run with:
//   npm run check:money
//
// These back a financial document, so the checks are property-style rather than
// a handful of examples: thousands of randomised rate/hour combinations across
// currencies with 0, 2 and 3 minor units, asserting that what gets printed adds
// up. Deterministic seed, so a failure reproduces.

import assert from 'node:assert/strict';
import {
  allocate,
  allocateMd,
  allocateShares,
  currencyMinorUnits,
  makeMoney,
  HOURS_PER_MD,
} from '../lib/export/pdf/money.ts';

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepStrictEqual(a, b, msg);
};

// Deterministic PRNG (mulberry32) — a failure is always reproducible.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Sum at a fixed precision, the way a reader adding up the printed column would.
const sumAt = (rows: number[], dp: number) =>
  Math.round(rows.reduce((a, b) => a + b * 10 ** dp, 0)) / 10 ** dp;

// ---- currencyMinorUnits ----

eq(currencyMinorUnits('CZK'), 2, 'CZK has 2 minor units');
eq(currencyMinorUnits('EUR'), 2, 'EUR has 2 minor units');
eq(currencyMinorUnits('USD'), 2, 'USD has 2 minor units');
eq(currencyMinorUnits('JPY'), 0, 'JPY has no minor units');
eq(currencyMinorUnits('HUF'), 0, 'HUF has no minor units');
eq(currencyMinorUnits('KWD'), 3, 'KWD has 3 minor units');
eq(currencyMinorUnits('czk'), 2, 'lowercase codes are accepted');
eq(currencyMinorUnits('XYZ'), 2, 'well-formed unknown code defaults to 2');
for (const bad of ['', 'CZ', 'CZKK', '123', 'C$K', ' CZ', 'kč']) {
  eq(currencyMinorUnits(bad), null, `"${bad}" is not a usable currency code`);
}

// ---- makeMoney: bad input must never silently lose the amount ----

for (const bad of ['', 'CZ', '123', 'Kč', 'CZKK']) {
  const m = makeMoney('cs-CZ', bad);
  const s = m.amount(65812.5);
  ok(/65[\s ]?812,50/.test(s), `garbage currency "${bad}" still prints the amount: ${s}`);
  if (bad) ok(s.includes(bad.toUpperCase()), `garbage currency "${bad}" keeps its code: ${s}`);
}

// The half-unit that started this: 58.5 h x 1125 must not print as a whole 65 813.
{
  const cs = makeMoney('cs-CZ', 'CZK');
  const en = makeMoney('en-GB', 'CZK');
  ok(/65[\s ]?812,50/.test(cs.amount(65812.5)), `cs CZK keeps haléře: ${cs.amount(65812.5)}`);
  ok(/65,812\.50/.test(en.amount(65812.5)), `en CZK keeps the .50: ${en.amount(65812.5)}`);
  eq(cs.dp, 2, 'CZK allocates in hundredths');
}

// A zero-decimal currency must not invent decimals.
{
  const jpy = makeMoney('en-GB', 'JPY');
  eq(jpy.dp, 0, 'JPY allocates in whole yen');
  ok(!jpy.amount(65813).includes('.'), `JPY prints no decimals: ${jpy.amount(65813)}`);
}

// A three-decimal currency must keep all three.
{
  const kwd = makeMoney('en-GB', 'KWD');
  eq(kwd.dp, 3, 'KWD allocates in fils');
  ok(/\.500$/.test(kwd.amount(1234.5)), `KWD prints 3 decimals: ${kwd.amount(1234.5)}`);
}

// Rates carry more precision than settled amounts, but never fewer decimals.
{
  const cs = makeMoney('cs-CZ', 'CZK');
  ok(/1[\s ]?125,00/.test(cs.rate(1125)), `round rate still shows minor units: ${cs.rate(1125)}`);
  ok(/1[\s ]?125,3333/.test(cs.rate(1125.3333)), `fine rate keeps precision: ${cs.rate(1125.3333)}`);
}

// ---- allocate: the printed rows always sum to the printed total ----

eq(allocate([], 2), { rows: [], total: 0 }, 'empty allocation is zero');
eq(allocate([0, 0, 0], 2).total, 0, 'all-zero allocation stays zero');

// The classic third-splitting case at every precision we support.
for (const dp of [0, 2, 3]) {
  const a = allocate([1 / 3, 1 / 3, 1 / 3], dp);
  eq(sumAt(a.rows, dp), a.total, `thirds sum exactly at ${dp} dp`);
}

{
  // Rows that individually round up must not overshoot the total.
  const a = allocate([0.605, 0.605, 0.605], 2);
  eq(sumAt(a.rows, 2), a.total, 'three .605 rows sum to their total');
  eq(a.total, 1.82, 'total is the rounded sum, not the sum of rounded rows');
}

{
  // Zero rows stay zero — an empty project must not be handed a stray unit.
  const a = allocate([0, 1 / 3, 1 / 3, 1 / 3], 2);
  eq(a.rows[0], 0, 'a zero row gains nothing');
  eq(sumAt(a.rows, 2), a.total, 'zero row does not break the sum');
}

// Randomised: realistic rates x quarter-hour blocks, across minor-unit counts.
{
  const rand = rng(20260719);
  const rates = [1125, 95.5, 1234.5678, 0.01, 78500, 1 / 3];
  for (const dp of [0, 2, 3]) {
    for (let trial = 0; trial < 4000; trial++) {
      const n = 1 + Math.floor(rand() * 12);
      const rate = rates[Math.floor(rand() * rates.length)];
      const hours = Array.from({ length: n }, () => Math.floor(rand() * 80) / 4);
      const a = allocate(
        hours.map((h) => h * rate),
        dp
      );
      eq(
        sumAt(a.rows, dp),
        a.total,
        `rows sum to total (dp=${dp}, rate=${rate}, hours=${hours.join(',')})`
      );
      ok(
        a.rows.every((r) => r >= 0),
        `no negative row (dp=${dp}, rate=${rate}, hours=${hours.join(',')})`
      );
      // Nobody may drift by a whole printed unit from their exact share.
      hours.forEach((h, i) => {
        ok(
          Math.abs(a.rows[i] - h * rate) < 1 / 10 ** dp,
          `row ${i} stays within one printed unit (dp=${dp}, rate=${rate})`
        );
      });
    }
  }
}

// ---- shares always total 100% ----

eq(allocateShares([1, 1, 1], 3), [34, 33, 33], 'thirds share out to exactly 100');
eq(allocateShares([], 0), [], 'no rows, no shares');
eq(allocateShares([5, 5], 0), [0, 0], 'a zero total yields zero shares, not NaN');
{
  const rand = rng(4242);
  for (let trial = 0; trial < 3000; trial++) {
    const n = 1 + Math.floor(rand() * 10);
    const vals = Array.from({ length: n }, () => Math.floor(rand() * 10000));
    const total = vals.reduce((a, b) => a + b, 0);
    const shares = allocateShares(vals, total);
    eq(
      shares.reduce((a, b) => a + b, 0),
      total > 0 ? 100 : 0,
      `shares total 100 (${vals.join(',')})`
    );
  }
}

// ---- MD column ----

eq(allocateMd([]).total, 0, 'no days, no MD');
{
  // 8 h is exactly one MD; the awkward 7 h / 9 h pair must still land on 2.00.
  eq(allocateMd([8 * 3600]).total, 1, 'eight hours is one MD');
  const a = allocateMd([7 * 3600, 9 * 3600]);
  eq(a.total, 2, '7 h + 9 h is two MD');
  eq(sumAt(a.rows, 2), a.total, '7/9 MD rows sum to the header total');
}
{
  // The drift case from the acceptance sheet: a month of 7 h and 9 h days.
  const days = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 7 : 9) * 3600);
  const a = allocateMd(days);
  eq(a.total, 20, 'twenty mixed days are twenty MD');
  eq(sumAt(a.rows, 2), a.total, 'twenty mixed days sum exactly');
}
{
  const rand = rng(99001);
  for (let trial = 0; trial < 3000; trial++) {
    const n = 1 + Math.floor(rand() * 31);
    // Quarter-hour granularity, plenty of empty days.
    const days = Array.from({ length: n }, () =>
      rand() < 0.3 ? 0 : Math.floor(rand() * 48) * 900
    );
    const a = allocateMd(days);
    eq(sumAt(a.rows, 2), a.total, `MD rows sum to total (${days.length} days)`);
    days.forEach((s, i) => {
      if (s === 0) eq(a.rows[i], 0, 'an empty day shows 0.00 MD');
    });
    eq(
      a.total,
      Math.round((days.reduce((x, y) => x + y, 0) / 3600 / HOURS_PER_MD) * 100) / 100,
      'MD total is the rounded exact total'
    );
  }
}

console.log(`✓ ${checks} money/allocation checks passed`);
