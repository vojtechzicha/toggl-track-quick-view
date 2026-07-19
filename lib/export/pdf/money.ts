// Financial primitives for the PDF templates: currency-aware formatting and
// exact allocation. These are deliberately free of app imports so they can be
// exercised on their own (see scripts/check-money.ts).
//
// The rule the whole file exists to enforce: **every printed subtotal must sum
// to the printed total, at the precision it is printed in**. Formatting a
// rounded number is not enough — rounding each row independently drifts, so the
// rows are allocated against the total up front and only then formatted.

/** Man-day basis. One MD is a standard eight-hour day. */
export const HOURS_PER_MD = 8;

/**
 * Decimal places a currency is quoted in (ISO 4217 minor units): 2 for CZK /
 * EUR / USD, 0 for JPY / HUF, 3 for KWD / TND. Unknown-but-well-formed codes
 * fall back to 2, which is what Intl itself assumes.
 *
 * Returns null when the code is not usable as a currency at all (empty, wrong
 * length, digits) — the caller then prints a bare number with the code appended
 * rather than pretending it knows the format.
 */
export function currencyMinorUnits(currency: string): number | null {
  if (!/^[A-Za-z]{3}$/.test(currency)) return null;
  try {
    const opts = new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).resolvedOptions();
    return opts.maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
}

export interface MoneyFormat {
  /** Decimal places amounts are allocated and printed in. */
  dp: number;
  /** A settled amount — always exactly `dp` decimals, so columns line up. */
  amount: (n: number) => string;
  /** A unit rate — `dp` decimals minimum, up to 4 when the rate is finer. */
  rate: (n: number) => string;
}

/**
 * Currency formatter pair for a locale. An unrecognised currency degrades to a
 * plain localized number with the raw code appended ("65 812,50 XYZ") — wrong
 * symbol beats wrong amount, and a silently dropped code would be worse still.
 */
export function makeMoney(localeTag: string, currency: string): MoneyFormat {
  const minor = currencyMinorUnits(currency);
  const dp = minor ?? 2;

  if (minor != null) {
    const code = currency.toUpperCase();
    try {
      const amountFmt = new Intl.NumberFormat(localeTag, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: dp,
        maximumFractionDigits: dp,
      });
      const rateFmt = new Intl.NumberFormat(localeTag, {
        style: 'currency',
        currency: code,
        minimumFractionDigits: dp,
        maximumFractionDigits: Math.max(dp, 4),
      });
      amountFmt.format(1); // probe: some engines defer validation to first use
      rateFmt.format(1);
      return { dp, amount: (n) => amountFmt.format(n), rate: (n) => rateFmt.format(n) };
    } catch {
      // fall through to the plain-number form below
    }
  }

  const suffix = currency ? ` ${currency.toUpperCase()}` : '';
  const amountFmt = new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  const rateFmt = new Intl.NumberFormat(localeTag, {
    minimumFractionDigits: dp,
    maximumFractionDigits: Math.max(dp, 4),
  });
  return {
    dp,
    amount: (n) => `${amountFmt.format(n)}${suffix}`,
    rate: (n) => `${rateFmt.format(n)}${suffix}`,
  };
}

/**
 * Largest-remainder allocation: round `exact` to `dp` decimals so the rounded
 * rows sum *exactly* to the rounded total.
 *
 * Rounding each row on its own drifts — 7 h and 9 h are both half a hundredth
 * of an MD off, so a month of them lands on 8.02 MD against an 8.00 header.
 * Instead: work in whole units of the last decimal place, floor every row, then
 * hand the shortfall to the rows that lost the most in flooring. Ties go to the
 * earlier row so the output is stable across runs.
 *
 * Returns numbers, not strings — the caller formats them with exactly `dp`
 * decimals, which is what makes the printed column add up.
 */
export function allocate(exact: number[], dp: number): { rows: number[]; total: number } {
  const scale = 10 ** dp;
  // Don't let float noise (0.145 stored as 0.14499999…) read as a floor loss.
  const EPS = 1e-9;
  const scaled = exact.map((v) => v * scale);
  const totalUnits = Math.round(scaled.reduce((a, b) => a + b, 0));
  const units = scaled.map((v) => Math.floor(v + EPS));

  let leftover = totalUnits - units.reduce((a, b) => a + b, 0);
  const byLoss = scaled
    .map((v, i) => ({ loss: v - Math.floor(v + EPS), i }))
    .sort((a, b) => b.loss - a.loss || a.i - b.i);
  for (let k = 0; k < byLoss.length && leftover > 0; k++, leftover--) units[byLoss[k].i] += 1;
  // Defensive: float noise can in principle overshoot. Claw back from the rows
  // that gained the least, so a row never drops below its floor.
  for (let k = byLoss.length - 1; k >= 0 && leftover < 0; k--, leftover++) units[byLoss[k].i] -= 1;

  return { rows: units.map((u) => u / scale), total: totalUnits / scale };
}

/**
 * Whole-percent shares of `total` that sum to exactly 100 (or to 0 when there
 * is nothing to divide). Same largest-remainder idea as `allocate`.
 */
export function allocateShares(values: number[], total: number): number[] {
  if (total <= 0 || values.length === 0) return values.map(() => 0);
  return allocate(
    values.map((v) => (v / total) * 100),
    0
  ).rows;
}

/** Hours → man-days, allocated so the rows sum to the printed MD total. */
export function allocateMd(secs: number[]): { rows: number[]; total: number } {
  return allocate(
    secs.map((s) => s / 3600 / HOURS_PER_MD),
    2
  );
}
