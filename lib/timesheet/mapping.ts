// Linked billing codes: bill another client's project as ONE code on this timesheet.
//
// Motivating shape: a prime contractor bills an engagement under a single code
// (say "D-SUB-1" on its timesheet), but the work itself is tracked for a
// sub-client project with its own billing codes ("S…" tags) and its own rounding
// grid. A CodeMapping declares that relationship for one Toggl project: entries on
// that project are validated against the *mapping's* tag prefix, grouped per linked
// code and rounded per day on the *mapping's* grid — exactly what the sub-client's
// own timesheet (a preset with that prefix/rounding) shows — and the day's rounded
// total is billed here as the single `targetCode` line.
//
// The load-bearing invariant: **per day, the sum of the sub-client's billed codes
// equals this sheet's mapped line.** It holds by construction, not reconciliation:
// `roundQuartersPreservingTotal` makes the per-code cells sum to the rounded day
// total, and that same rounded total is what the mapped line carries. To keep it,
// everything that shapes the value happens *upstream, on the sub-client's terms*:
// the per-day rounding uses the mapping's grid, and — when the mapping declares
// the sub-client's own no-overtime contract — its weekly cap is applied here with
// the very same trim its own sheet runs. What arrives at this sheet is therefore
// exactly what the sub-client's timesheet shows, and the builders treat it as
// fixed: this sheet's own rounding pass never re-rounds it and this sheet's
// "don't bill overtime" NEVER trims it, no matter what — the mapped time still
// counts toward the weekly cap, so trimming shaves that much more off the native
// rows instead.

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
  /** The Toggl project whose entries are mapped (must be among the selected projects). */
  projectId: number;
  /** The prefix marking that project's billing tags (e.g. "S" for "S123" codes). */
  tagPrefix: string;
  /**
   * The sub-client's rounding grid (hours). Settings enforce it stays on this
   * config's grid (equal to it, or a whole multiple of it) so every figure on this
   * sheet remains a clean multiple of the configured unit.
   */
  roundingHours: number;
  /** The single billing code the mapped time bills to here (e.g. "D-SUB-1"). */
  targetCode: string;
  /**
   * The sub-client's own "don't bill overtime" contract. When true, the linked
   * project's week is capped at `weeklyHours` *before* it bills here — trimmed on
   * the mapping's grid with the same weekend-in-full / weekday-evening cut its own
   * sheet applies — so this sheet carries whatever that sheet actually bills.
   * This sheet's own overtime setting still never touches the linked line.
   * (Absent on mappings stored before this existed — treated as false.)
   */
  noOvertime?: boolean;
  /** The sub-client's weekly cap (hours); only used when `noOvertime` is true. */
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
 * Summary-grid row key for a mapped project. Its own "m" namespace: a mapped
 * project collapses to one row regardless of how many linked codes it carries, so
 * it can't collide with the native `p{id}|{tag}` keys.
 */
export function mappedRowKey(projectId: number): string {
  return `m${projectId}`;
}

/** True when the summary row key belongs to a mapped (fixed, pre-rounded) row. */
export function isMappedRowKey(rowKey: string): boolean {
  return rowKey.startsWith('m');
}

/**
 * True when the mapping's grid keeps figures on the config's grid: its unit is the
 * config unit or a whole multiple of it (0.5h onto a 0.25h sheet is fine; 0.2h onto
 * a 0.25h sheet is not). Settings coerce incompatible picks on save; the builders
 * still work with an incompatible legacy value, the figures just leave the grid.
 */
export function mappingGridCompatible(
  mappingRoundingHours: number,
  configRoundingHours: number
): boolean {
  const m = roundingUnitSeconds(mappingRoundingHours);
  const c = roundingUnitSeconds(configRoundingHours);
  return c > 0 && m % c === 0;
}

/** Accumulator for one (mapped project, day): raw per-code time plus display bits. */
export interface MappedAgg {
  /** Raw seconds per linked code (display base — "(X)"/"(!)" merged into the plain twin). */
  codeSeconds: Map<string, number>;
  /** Of `codeSeconds`, the "(X)"-marked share per code — the sub-trim's budget. */
  codeTrimmable: Map<string, number>;
  /** Of `codeSeconds`, the "(!)"-marked share per code — never trimmed. */
  codeNoTrim: Map<string, number>;
  /** De-duplicated entry descriptions, first-seen order. */
  descs: string[];
  /** Raw total seconds (pre-rounding), for cells that carry raw values. */
  seconds: number;
  /** Earliest entry start (ms) — anchors the day block in the Individual view. */
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

/** Fold one entry (already validated to carry exactly one linked tag) into the day. */
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

/** A finalized mapped day: the fixed billed value plus what the cell displays. */
export interface MappedDayValue {
  /** Rounded (and sub-trimmed) seconds billed to the target code this day. */
  seconds: number;
  /**
   * Cell descriptions: the per-code breakdown first (e.g. "S101 3.25h, S102 1.5h"
   * — the sub-client sheet's own cells, for traceability), then the merged entry
   * descriptions.
   */
  descs: string[];
}

/**
 * Close a week's aggregates for one mapping into the fixed per-day values this
 * sheet bills — reproducing the sub-client's own summary sheet:
 *
 * 1. Per day, the per-code seconds are rounded on the *mapping's* grid with the
 *    same largest-remainder method, so the breakdown matches that sheet
 *    cell-for-cell and sums to its rounded day total.
 * 2. When the mapping declares the sub-client's own no-overtime contract, the
 *    week is then capped at the mapping's `weeklyHours` with the identical trim
 *    that sheet runs (weekend billed in full, weekdays evened out, "(X)"-marked
 *    portions cut first, a month boundary splitting the cap) — so what bills
 *    here is what that sheet bills, trimmed or not.
 *
 * Week-scoped because the cap is a weekly affair; days with no mapped time simply
 * have no aggregate and produce no value. `holidays` is the sheet's holiday set
 * (days marked by a time-off entry): a holiday shrinks the sub-client's weekly cap
 * exactly as it shrinks this sheet's — the person's day off is the same day off on
 * both engagements.
 */
export function finalizeMappedWeek(
  aggByDay: ReadonlyMap<number, MappedAgg>,
  mapping: CodeMapping,
  weekStart: number,
  holidays?: HolidaySet
): Map<number, MappedDayValue> {
  const unit = roundingUnitSeconds(mapping.roundingHours);

  // The sub sheet's own per-day rounding pass, yielding one cell per (day, code)
  // in whole mapping-grid units, each with its "(X)" trim budget and "(!)" floor.
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

  // The sub-client's own overtime pass, when declared on the mapping.
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

  // Collapse to per-day fixed values; the breakdown shows the post-trim figures
  // (what the sub sheet actually bills), fully-trimmed codes dropped.
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
 * How an entry bills: its billing tags under the prefix its project actually
 * uses, plus the support-ticket fallback — an entry with NO billing tag whose
 * description starts with a bracketed ticket id ("[T-123] Fix login") bills to
 * that id as if tagged, with the bracket dropped from the billed description
 * (see supportTicket in lib/calc). Entries with a real tag — or with several,
 * which stay a warning — keep their description untouched.
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
