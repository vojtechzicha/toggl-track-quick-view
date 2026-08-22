// Data shaping for the Timesheet Acceptance Protocol templates. The sheet is
// day-based regardless of view: one row per calendar day of the exported range
// (empty days included). Man-days assume the common 8h day (HOURS_PER_MD,
// shared with the report templates).
//
// Two variants share the sheet. "full" lists every exported row of the day
// verbatim; "compact" renders the day as one line — every billing code, then a
// single overall description (see ./acceptanceCompact). The variants differ
// ONLY in the Project / Task cell text — the day's Hours and MD figures come
// from the same seconds either way.
//
// Both visual designs (the identity layout and the original spreadsheet-green
// one) render exactly this data, so the printed figures cannot drift between
// them.

import type { ExportDoc } from '../model';
import { weeksInRange } from '../range';
import { DAY_MS } from '@/lib/timesheet/constants';
import { allocateMd } from './money';
import { compactDayText, fixDescTypos, type CompactRow } from './acceptanceCompact';

export type AcceptanceVariant = 'full' | 'compact';

export const fmtNum = (n: number): string => n.toFixed(2);
export const secsToHoursNumLabel = (secs: number): string => fmtNum(secs / 3600);

/**
 * Per-day MD labels (2 dp) whose sum is exactly the period total's 2 dp value —
 * see `allocateMd`, which does the largest-remainder work.
 */
export function mdColumn(daySecs: number[]): { rows: string[]; total: string } {
  const { rows, total } = allocateMd(daySecs);
  return { rows: rows.map(fmtNum), total: fmtNum(total) };
}

export const fmtDayMonth = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getDate()}/${d.getMonth() + 1}`;
};
export const fmtFullDate = (ms: number): string =>
  `${fmtDayMonth(ms)}/${new Date(ms).getFullYear()}`;

/** ISO-8601 week number (weeks start Monday; week 1 contains the year's first Thursday). */
export function isoWeek(ms: number): number {
  const d = new Date(ms);
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7)); // the week's Thursday
  const week1 = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round(((t.getTime() - week1.getTime()) / DAY_MS - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

export interface DayAgg {
  seconds: number;
  tasks: string[]; // deduped "code - description" lines (or the one compact line)
  rows: CompactRow[]; // the day's exported rows, the compact aggregation's input
}

function pushTask(agg: DayAgg, code: string, desc: string): void {
  const fixed = fixDescTypos(desc);
  const text = code && fixed ? `${code} - ${fixed}` : code || fixed;
  if (!text) return;
  if (!agg.tasks.some((t) => t.toLowerCase() === text.toLowerCase())) agg.tasks.push(text);
}

/** Per-day totals and task texts, keyed by the day's ms (same keys the builders emit). */
export function acceptanceDays(doc: ExportDoc, variant: AcceptanceVariant): Map<number, DayAgg> {
  const byDay = new Map<number, DayAgg>();
  const day = (ms: number): DayAgg => {
    let agg = byDay.get(ms);
    if (!agg) {
      agg = { seconds: 0, tasks: [], rows: [] };
      byDay.set(ms, agg);
    }
    return agg;
  };
  const push = (agg: DayAgg, code: string, billingCode: string, desc: string, seconds: number) => {
    if (variant === 'compact') agg.rows.push({ code, billingCode, desc, seconds });
    else pushTask(agg, code, desc);
  };
  if (doc.view === 'individual') {
    for (const d of doc.days) {
      const agg = day(d.dateMs);
      agg.seconds += d.total;
      for (const r of d.rows) push(agg, r.code, r.billingCode, r.desc, r.hours);
    }
  } else {
    for (const week of doc.weeks) {
      week.dayDates.forEach((dateMs, ci) => {
        if (week.dayTotals[ci] <= 0) return;
        const agg = day(dateMs);
        agg.seconds += week.dayTotals[ci];
        for (const row of week.rows) {
          if (row.cells[ci] > 0) {
            push(agg, row.label, row.billingCode, row.dayDescs[ci], row.cells[ci]);
          }
        }
      });
    }
  }
  if (variant === 'compact') {
    for (const agg of byDay.values()) {
      if (agg.rows.length > 0) agg.tasks = [compactDayText(agg.rows)];
    }
  }
  return byDay;
}

/**
 * Every calendar day of the range, worked or not — enumerated with the same
 * week+offset arithmetic the builders use, so the keys line up.
 */
export function calendarDays(doc: ExportDoc): number[] {
  const dayList: number[] = [];
  for (const ws of weeksInRange(doc.fromMs, doc.toMs)) {
    for (let d = 0; d < 7; d++) {
      const ms = ws + d * DAY_MS;
      if (ms >= doc.fromMs && ms < doc.toMs) dayList.push(ms);
    }
  }
  return dayList;
}
