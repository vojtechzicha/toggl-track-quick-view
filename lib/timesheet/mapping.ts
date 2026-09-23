// Linked billing codes: bill another client's project as one code on this
// timesheet.
//
// Example: a prime contractor bills an engagement as "D-SUB-1", but the work is
// tracked on a sub-client project with its own codes ("S…" tags) and rounding.
// A CodeMapping links one Toggl project to that code. Its entries are checked
// against the mapping's tag prefix, grouped per linked code and rounded per day
// on the mapping's grid, as the sub-client's own timesheet would show them. The
// rounded day total bills here as the single `targetCode` line.
//
// Invariant: per day, the sub-client's billed codes sum to this sheet's mapped
// line. roundQuartersPreservingTotal makes the per-code cells sum to the rounded
// day total, and the mapped line carries that total. So all shaping happens on
// the sub-client's terms: rounding uses the mapping's grid, and the mapping's
// own no-overtime cap (if set) is applied with the same trim. This sheet treats
// the result as fixed: its rounding never re-rounds it and its overtime cap
// never trims it. Mapped time still counts toward this sheet's cap, so the trim
// falls on the native rows.

import {
  billingTagsOf,
  fmtHours,
  parseBillingCode,
  roundQuartersPreservingTotal,
  roundingUnitSeconds,
  supportTicket,
  type HolidaySet,
} from '@/lib/calc';
import { allocateOvertimeTrimPerDay, weekSegments } from './overtime';

/** One linked-code rule: how a sub-client project bills onto this timesheet. */
export interface CodeMapping {
  /** The mapped Toggl project. Must be one of the selected projects. */
  projectId: number;
  /** The billing-tag prefix on that project (e.g. "S" for "S123"). */
  tagPrefix: string;
  /**
   * The sub-client's rounding unit (hours). Settings keep it equal to, or a
   * whole multiple of, this sheet's unit so every figure stays on this grid.
   */
  roundingHours: number;
  /** The billing code the mapped time bills to here (e.g. "D-SUB-1"). */
  targetCode: string;
  /**
   * The sub-client's "don't bill overtime" setting. When true, the linked
   * project's week is capped at `weeklyHours` before it bills here, with the
   * same trim the sub-client's sheet applies. Absent means false.
   */
  noOvertime?: boolean;
  /** The sub-client's weekly cap in hours. Used only when `noOvertime` is true. */
  weeklyHours?: number;
}

/** The mapping covering a project, or undefined when the project bills natively. */
export function mappingFor(
  mappings: CodeMapping[] | undefined,
  projectId: number | null
): CodeMapping | undefined {
  if (projectId == null || !mappings?.length) return undefined;
  return mappings.find((m) => m.projectId === projectId);
}

/**
 * Summary-grid row key for a mapped project, which is always one row. The "m"
 * prefix keeps it apart from native `p{id}|{tag}` keys.
 */
export function mappedRowKey(projectId: number): string {
  return `m${projectId}`;
}

/** True for a mapped (fixed, pre-rounded) summary row key. */
export function isMappedRowKey(rowKey: string): boolean {
  return rowKey.startsWith('m');
}

/**
 * True when the mapping's unit equals, or is a whole multiple of, the sheet's
 * (0.5h on a 0.25h sheet is fine; 0.2h is not). Settings replace an
 * incompatible unit on save. The builders still work with one, but the figures
 * leave the sheet's grid.
 */
export function mappingGridCompatible(
  mappingRoundingHours: number,
  configRoundingHours: number
): boolean {
  const m = roundingUnitSeconds(mappingRoundingHours);
  const c = roundingUnitSeconds(configRoundingHours);
  return c > 0 && m % c === 0;
}

/** Accumulator for one mapped project on one day. */
export interface MappedAgg {
  /** Raw seconds per linked code, keyed by display base ("(X)"/"(!)" merged in). */
  codeSeconds: Map<string, number>;
  /** The "(X)" share of `codeSeconds` per code. */
  codeTrimmable: Map<string, number>;
  /** The "(!)" share of `codeSeconds` per code. Never trimmed. */
  codeNoTrim: Map<string, number>;
  /** Distinct entry descriptions (case-insensitive), in first-seen order. */
  descs: string[];
  /** Raw total seconds before rounding. */
  seconds: number;
  /** Earliest entry start (ms). Places the day's block in the Individual view. */
  firstStartMs: number;
}

export function newMappedAgg(startMs: number): MappedAgg {
  return {
    codeSeconds: new Map(),
    codeTrimmable: new Map(),
    codeNoTrim: new Map(),
    descs: [],
    seconds: 0,
    firstStartMs: startMs,
  };
}

/** Add one entry to the day. The entry must carry exactly one linked tag. */
export function addToMappedAgg(
  agg: MappedAgg,
  tag: string,
  seconds: number,
  desc: string | undefined,
  startMs: number
): void {
  const { base, trimmable, neverTrim } = parseBillingCode(tag);
  agg.codeSeconds.set(base, (agg.codeSeconds.get(base) ?? 0) + seconds);
  if (trimmable) agg.codeTrimmable.set(base, (agg.codeTrimmable.get(base) ?? 0) + seconds);
  if (neverTrim) agg.codeNoTrim.set(base, (agg.codeNoTrim.get(base) ?? 0) + seconds);
  agg.seconds += seconds;
  agg.firstStartMs = Math.min(agg.firstStartMs, startMs);
  const text = desc?.trim();
  if (text && !agg.descs.some((d) => d.toLowerCase() === text.toLowerCase())) {
    agg.descs.push(text);
  }
}

/** A finalized mapped day: the billed value and the cell descriptions. */
export interface MappedDayValue {
  /** Rounded (and, with the mapping's cap, trimmed) seconds billed this day. */
  seconds: number;
  /**
   * The per-code breakdown first (e.g. "S101 3.25h, S102 1.5h", matching the
   * sub-client's sheet), then the entry descriptions.
   */
  descs: string[];
}

/**
 * Turn a week's aggregates for one mapping into the per-day values this sheet
 * bills, reproducing the sub-client's summary sheet:
 *
 * 1. Each day's per-code seconds are rounded on the mapping's grid, so the
 *    breakdown matches that sheet and sums to its day total.
 * 2. With `noOvertime`, the week is capped at the mapping's `weeklyHours` with
 *    the Summary view's trim (allocateOvertimeTrimPerDay, per month segment).
 *
 * `holidays` is this sheet's holiday set; it shrinks the sub-client's cap too.
 * Days without mapped time produce no value.
 */
export function finalizeMappedWeek(
  aggByDay: ReadonlyMap<number, MappedAgg>,
  mapping: CodeMapping,
  weekStart: number,
  holidays?: HolidaySet
): Map<number, MappedDayValue> {
  const unit = roundingUnitSeconds(mapping.roundingHours);

  // Per-day rounding: one cell per (day, code) in whole mapping units, with its
  // "(X)" and "(!)" shares.
  const cells: {
    day: number;
    code: string;
    units: number;
    trimmableUnits: number;
    noTrimUnits: number;
  }[] = [];
  for (const [day, agg] of aggByDay) {
    const codes = [...agg.codeSeconds.keys()].sort((a, b) => a.localeCompare(b));
    const rounded = roundQuartersPreservingTotal(
      codes.map((c) => agg.codeSeconds.get(c) ?? 0),
      { unitSeconds: unit }
    );
    codes.forEach((code, i) => {
      const units = Math.round(rounded[i] / unit);
      if (units <= 0) return;
      const secs = agg.codeSeconds.get(code) ?? 0;
      const frac = secs > 0 ? (agg.codeTrimmable.get(code) ?? 0) / secs : 0;
      const trimmableUnits = Math.min(units, Math.round(units * frac));
      const fracKeep = secs > 0 ? (agg.codeNoTrim.get(code) ?? 0) / secs : 0;
      const noTrimUnits = Math.min(units - trimmableUnits, Math.round(units * fracKeep));
      cells.push({ day, code, units, trimmableUnits, noTrimUnits });
    });
  }

  // The mapping's own overtime cap.
  if (mapping.noOvertime && (mapping.weeklyHours ?? 0) > 0) {
    for (const seg of weekSegments(weekStart, mapping.weeklyHours as number, unit, holidays)) {
      const idx = cells
        .map((_, i) => i)
        .filter((i) => cells[i].day >= seg.startDay && cells[i].day <= seg.endDay);
      const removed = allocateOvertimeTrimPerDay(
        idx.map((i) => ({
          units: cells[i].units,
          trimmableUnits: cells[i].trimmableUnits,
          noTrimUnits: cells[i].noTrimUnits,
          day: cells[i].day,
        })),
        seg.capUnits,
        holidays
      );
      idx.forEach((i, k) => (cells[i].units -= removed[k]));
    }
  }

  // Per-day values. The breakdown shows post-trim figures and omits codes
  // trimmed to zero.
  const out = new Map<number, MappedDayValue>();
  for (const [day, agg] of aggByDay) {
    const parts = cells.filter((c) => c.day === day && c.units > 0);
    const seconds = parts.reduce((s, c) => s + c.units * unit, 0);
    const breakdown = parts.map((c) => `${c.code} ${fmtHours(c.units * unit)}`).join(', ');
    out.set(day, { seconds, descs: breakdown ? [breakdown, ...agg.descs] : [...agg.descs] });
  }
  return out;
}

/**
 * An entry's billing tags under its project's prefix. With no billing tag, a
 * support-ticket id opening the description is used instead and removed from
 * the description (see supportTicket in lib/calc).
 */
export function entryBilling(
  tags: string[] | undefined,
  description: string | undefined,
  mapping: CodeMapping | undefined,
  billingTagPrefix: string
): { tags: string[]; description: string } {
  const found = billingTagsOf(tags, mapping ? mapping.tagPrefix : billingTagPrefix);
  if (found.length === 0) {
    const ticket = supportTicket(description);
    if (ticket) return { tags: [ticket.code], description: ticket.rest };
  }
  return { tags: found, description: description ?? '' };
}
