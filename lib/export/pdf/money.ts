// Currency formatting and exact allocation for the PDF templates. No app
// imports, so scripts/check-money.ts can test it alone.
//
// Invariant: printed subtotals sum to the printed total at the printed
// precision. Rounding each row on its own drifts, so rows are allocated
// against the total first and formatted after.

/** Man-day basis. One MD is a standard eight-hour day. */
export const HOURS_PER_MD = 8;

/**
 * Decimal places a currency is quoted in (ISO 4217 minor units): 2 for CZK /
 * EUR / USD, 0 for JPY / HUF, 3 for KWD / TND. A well-formed unknown code gets
 * 2, as in Intl. Null when the code is not three letters.
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
  /** A settled amount, always `dp` decimals so columns line up. */
  amount: (n: number) => string;
  /** A unit rate: at least `dp` decimals, up to 4 when the rate is finer. */
  rate: (n: number) => string;
}

/**
 * Amount and rate formatters for a locale. An unusable currency code falls back
 * to a plain localized number with the code appended ("65 812,50 XYZ"), so the
 * amount and the code are never lost.
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
 * rows sum to the rounded total.
 *
 * Rounding rows independently drifts: 7 h and 9 h are 0.875 and 1.125 MD, both
 * round up, and twenty such days print 20.10 MD against a 20.00 total. Instead,
 * work in units of the last decimal place, floor every row, and give the
 * shortfall to the rows that lost most in flooring. Ties go to the earlier row
 * so output is stable.
 *
 * The caller must format the result with exactly `dp` decimals.
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
  // Float noise could overshoot; take back from the rows with the smallest loss.
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
