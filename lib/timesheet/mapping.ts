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
// the mapped value is *pre-rounded upstream* — this sheet's own rounding pass and
// overtime trimming must never touch it (the builders treat mapped rows as fixed).
// The mapped time still counts toward the weekly overtime cap, so trimming shaves
// that much more off the native rows instead.

import {
  billingTagsOf,
  fmtHours,
  parseBillingCode,
  roundQuartersPreservingTotal,
  roundingUnitSeconds,
} from '@/lib/calc';

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
  /** Raw seconds per linked code (display base — "(X)" merged into its plain twin). */
  codeSeconds: Map<string, number>;
  /** De-duplicated entry descriptions, first-seen order. */
  descs: string[];
  /** Raw total seconds (pre-rounding), for cells that carry raw values. */
  seconds: number;
  /** Earliest entry start (ms) — anchors the day block in the Individual view. */
  firstStartMs: number;
}

export function newMappedAgg(startMs: number): MappedAgg {
  return { codeSeconds: new Map(), descs: [], seconds: 0, firstStartMs: startMs };
}

/** Fold one entry (already validated to carry exactly one linked tag) into the day. */
export function addToMappedAgg(
  agg: MappedAgg,
  tag: string,
  seconds: number,
  desc: string | undefined,
  startMs: number
): void {
  const { base } = parseBillingCode(tag);
  agg.codeSeconds.set(base, (agg.codeSeconds.get(base) ?? 0) + seconds);
  agg.seconds += seconds;
  agg.firstStartMs = Math.min(agg.firstStartMs, startMs);
  const text = desc?.trim();
  if (text && !agg.descs.some((d) => d.toLowerCase() === text.toLowerCase())) {
    agg.descs.push(text);
  }
}

/** A finalized mapped day: the fixed billed value plus what the cell displays. */
export interface MappedDayValue {
  /** Rounded seconds billed to the target code this day — the invariant value. */
  seconds: number;
  /**
   * Cell descriptions: the per-code breakdown first (e.g. "S101 3.25h, S102 1.5h"
   * — the sub-client sheet's own cells, for traceability), then the merged entry
   * descriptions.
   */
  descs: string[];
}

/**
 * Close a day's aggregate: round the per-code seconds on the *mapping's* grid with
 * the same largest-remainder method the sub-client's own summary uses, so the
 * breakdown reproduces that sheet cell-for-cell and its sum is that sheet's rounded
 * day total — the value billed here.
 */
export function finalizeMappedAgg(agg: MappedAgg, mapping: CodeMapping): MappedDayValue {
  const codes = [...agg.codeSeconds.keys()].sort((a, b) => a.localeCompare(b));
  const unit = roundingUnitSeconds(mapping.roundingHours);
  const rounded = roundQuartersPreservingTotal(
    codes.map((c) => agg.codeSeconds.get(c) ?? 0),
    { unitSeconds: unit }
  );
  const parts = codes
    .map((code, i) => ({ code, secs: rounded[i] }))
    .filter((p) => p.secs > 0);
  const seconds = parts.reduce((s, p) => s + p.secs, 0);
  const breakdown = parts.map((p) => `${p.code} ${fmtHours(p.secs)}`).join(', ');
  return { seconds, descs: breakdown ? [breakdown, ...agg.descs] : [...agg.descs] };
}

/** The billing tags of an entry under the prefix its project actually uses. */
export function entryBillingTags(
  tags: string[] | undefined,
  mapping: CodeMapping | undefined,
  billingTagPrefix: string
): string[] {
  return billingTagsOf(tags, mapping ? mapping.tagPrefix : billingTagPrefix);
}
