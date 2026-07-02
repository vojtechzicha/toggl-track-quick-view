// Pure builder for the Individual timesheet view. Shared by the on-screen
// IndividualTimesheet component and the exporters so they show identical figures
// (same same-code combining, same biased quarter-hour rounding, same time anchoring).

import {
  fmtHoursLabel,
  fmtTimeOfDay,
  parseBillingCode,
  roundQuartersPreservingTotal,
  type TimeEntry,
} from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { allocateOvertimeTrim, weekSegments } from './overtime';
import {
  addToMappedAgg,
  entryBillingTags,
  finalizeMappedWeek,
  mappingFor,
  newMappedAgg,
  type CodeMapping,
  type MappedAgg,
} from './mapping';
import { DAY_MS, UNTAGGED, MULTIPLE, TOOLONG } from './constants';

const COMBINE_GAP_SECONDS = 60 * 60; // combine same-code entries only within this gap
const OVERLAP_MIN_MS = 60 * 1000; // ignore sub-minute touches (display/manual-entry noise)

/** A raw selected-project entry for one day, normalised to ms bounds. */
interface DayEntry {
  startMs: number;
  stopMs: number;
  seconds: number;
  projId: number | null;
  tags?: string[];
  desc: string;
}

export type WarnKind = typeof UNTAGGED | typeof MULTIPLE | typeof TOOLONG;

/** One rendered line: a billable entry (with a time span) or a warning aggregate. */
export interface Row {
  key: string;
  kind: 'bill' | 'warn';
  warn?: WarnKind;
  code?: string; // billing tag (display base, "(X)" stripped), for 'bill' rows
  projId?: number | null; // owning project, for 'bill' rows
  seconds: number; // raw, pre-rounding
  trimmableSeconds?: number; // of `seconds`, how much came from "(X)"-marked entries
  rounded: number; // filled in after rounding
  startMs?: number; // anchored display start (bill rows, after rounding)
  endMs?: number; // start + rounded duration
  descs: string[];
  groupStartMs: number; // first raw start, used to anchor the display time
  // A linked-code day block: `rounded` is already fixed on the mapping's own grid
  // (equal to the sub-client sheet's day total), so it's never re-rounded, trimmed
  // or length-checked here (see lib/timesheet/mapping).
  fixed?: boolean;
}

export interface IndividualDay {
  dayIdx: number;
  dateMs: number;
  rows: Row[];
  total: number;
  overlaps: string[];
  // Billable hours stripped from this day to keep the week within the cap when
  // overtime isn't billable (seconds). Shown on a separate "Overtime" line; not
  // part of `total` (which is what's actually billed).
  overtime: number;
}

export interface IndividualWeek {
  days: IndividualDay[];
  grandTotal: number;
}

export interface IndividualInput {
  entries: TimeEntry[];
  weekStart: number;
  nowMs: number;
  projects: SelectedProject[];
  maxBillableHours: number;
  billingTagPrefix: string;
  // The rounding granularity in seconds (e.g. 900 = 15 min, 720 = 12 min).
  roundingSeconds: number;
  // When true, the week's billable total is trimmed down to `weeklyHours` (the
  // contract disallows billing overtime); the trimmed time surfaces as an
  // "Overtime" line. When false, neither input has any effect.
  noOvertime: boolean;
  weeklyHours: number;
  // Linked billing codes: projects whose entries carry another client's tags and
  // bill here as one fixed day block per project (see lib/timesheet/mapping).
  codeMappings?: CodeMapping[];
}

export function warnLabel(kind: WarnKind, maxBillableHours: number): string {
  switch (kind) {
    case UNTAGGED:
      return 'No billing tag';
    case MULTIPLE:
      return 'Multiple billing tags';
    case TOOLONG:
      return `Too long to bill individually (> ${fmtHoursLabel(maxBillableHours)})`;
  }
}

function mergeDesc(into: string[], desc: string) {
  const text = desc.trim();
  if (!text) return;
  if (into.some((d) => d.toLowerCase() === text.toLowerCase())) return;
  into.push(text);
}

/** Snap an absolute time to the nearest rounding-unit clock mark. */
function snapToUnit(ms: number, unitMs: number): number {
  return Math.round(ms / unitMs) * unitMs;
}

/** A day classified into billable lines and warning aggregates, already rounded. */
interface ClassifiedDay {
  bill: Row[];
  warnRows: Row[];
  overlaps: string[];
  // Linked-code aggregates by mapped project id. Closing them is week-scoped
  // (the mapping may carry the sub-client's weekly no-overtime cap), so the
  // fixed day blocks are built in buildIndividualWeek, not here.
  mapped: Map<number, MappedAgg>;
}

/**
 * Classify one day's selected-project entries into billable lines and warning
 * aggregates, and round them.
 *
 * Entries are classified, then consecutive same-code entries are combined while
 * the gap stays within an hour and the combined duration stays billable (within
 * the cap). Durations are rounded to the configured unit preserving the day total
 * (biased so a tiny entry surfaces rather than vanishing). Zero-rounded billable
 * lines are kept here (the caller drops them after any overtime trimming) and no
 * time anchoring is done yet — that happens in `finalizeDay`, after the week-level
 * overtime pass has had a chance to shave durations.
 */
function classifyDay(
  dayEntries: DayEntry[],
  maxBillableSeconds: number,
  billingTagPrefix: string,
  roundingSeconds: number,
  codeMappings?: CodeMapping[]
): ClassifiedDay {
  const sorted = [...dayEntries].sort((a, b) => a.startMs - b.startMs);

  // Overlaps in the raw data (you can't bill two entries running at once). Sorted
  // by start, so once a later entry begins at/after this one's stop, nothing
  // further can overlap it.
  const overlaps: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startMs >= sorted[i].stopMs) break;
      // Entries that merely touch (or overlap by seconds, which the minute-level
      // display can't even show) aren't worth flagging — only a real overlap is.
      const overlapMs = Math.min(sorted[i].stopMs, sorted[j].stopMs) - sorted[j].startMs;
      if (overlapMs < OVERLAP_MIN_MS) continue;
      overlaps.push(
        `${fmtTimeOfDay(sorted[i].startMs)}–${fmtTimeOfDay(sorted[i].stopMs)} ⨯ ` +
          `${fmtTimeOfDay(sorted[j].startMs)}–${fmtTimeOfDay(sorted[j].stopMs)}`
      );
    }
  }

  const bill: Row[] = [];
  const warnBuckets: Record<WarnKind, Row | null> = {
    [UNTAGGED]: null,
    [MULTIPLE]: null,
    [TOOLONG]: null,
  };
  const addWarn = (kind: WarnKind, e: DayEntry) => {
    let row = warnBuckets[kind];
    if (!row) {
      row = { key: kind, kind: 'warn', warn: kind, seconds: 0, rounded: 0, descs: [], groupStartMs: e.startMs };
      warnBuckets[kind] = row;
    }
    row.seconds += e.seconds;
    mergeDesc(row.descs, e.desc);
  };

  let current: Row | null = null; // open billable group being combined into
  let lastStopMs = 0; // stop of the last entry merged into `current`
  const flush = () => {
    current = null;
  };

  // Linked-code accumulators, one per mapped project this day. Their entries are
  // folded into a single fixed day block (built after the loop) instead of normal
  // billable lines.
  const mappedByProj = new Map<number, MappedAgg>();

  for (const e of sorted) {
    // A mapped project's entries are validated against the *mapping's* prefix, so
    // its untagged/multi-tagged entries surface in the same warning rows.
    const mapping = mappingFor(codeMappings, e.projId);
    const tags = entryBillingTags(e.tags, mapping, billingTagPrefix);
    if (tags.length === 0) {
      flush();
      addWarn(UNTAGGED, e);
      continue;
    }
    if (tags.length > 1) {
      flush();
      addWarn(MULTIPLE, e);
      continue;
    }
    if (mapping) {
      // Linked code: fold into the project's day aggregate. The billable-length
      // cap doesn't apply — the block is an aggregate of the whole day by design,
      // like a Summary cell, not an individually billed entry.
      flush();
      let agg = mappedByProj.get(e.projId as number);
      if (!agg) {
        agg = newMappedAgg(e.startMs);
        mappedByProj.set(e.projId as number, agg);
      }
      addToMappedAgg(agg, tags[0], e.seconds, e.desc, e.startMs);
      continue;
    }
    if (e.seconds > maxBillableSeconds) {
      flush();
      addWarn(TOOLONG, e); // a single oversize entry can't be split
      continue;
    }

    // The "(X)" marker is just a trimmable *version* of the same billing code, so
    // it merges into its plain twin: one displayed line, with the "(X)" seconds
    // tracked separately as the trim budget. Same code under two different projects
    // still stays separate (a project is a group of billing tags).
    const { base, trimmable } = parseBillingCode(tags[0]);
    const canCombine =
      current !== null &&
      current.code === base &&
      current.projId === e.projId &&
      e.startMs - lastStopMs <= COMBINE_GAP_SECONDS * 1000 &&
      current.seconds + e.seconds <= maxBillableSeconds;

    if (canCombine && current) {
      current.seconds += e.seconds;
      if (trimmable) current.trimmableSeconds = (current.trimmableSeconds ?? 0) + e.seconds;
      mergeDesc(current.descs, e.desc);
    } else {
      current = {
        key: `b${e.startMs}`,
        kind: 'bill',
        code: base,
        projId: e.projId,
        seconds: e.seconds,
        trimmableSeconds: trimmable ? e.seconds : 0,
        rounded: 0,
        descs: [],
        groupStartMs: e.startMs,
      };
      mergeDesc(current.descs, e.desc);
      bill.push(current);
    }
    lastStopMs = e.stopMs;
  }

  // Rows that take part in the day's rounding: billable lines first, then any
  // warning aggregates. Bias the spare quarters toward would-be-zero entries so
  // small entries surface (a billable line still at zero is then dropped). The
  // linked-code aggregates stay out — they're rounded (and possibly sub-trimmed)
  // on their own grid at week level, in buildIndividualWeek.
  const warnRows = ([UNTAGGED, MULTIPLE, TOOLONG] as WarnKind[])
    .map((k) => warnBuckets[k])
    .filter((r): r is Row => r !== null);
  const allRows = [...bill, ...warnRows];
  const rounded = roundQuartersPreservingTotal(
    allRows.map((r) => r.seconds),
    { biasZero: true, unitSeconds: roundingSeconds }
  );
  allRows.forEach((r, i) => (r.rounded = rounded[i]));

  return { bill, warnRows, overlaps, mapped: mappedByProj };
}

/**
 * Turn a classified (and possibly overtime-trimmed) day into its rendered rows.
 *
 * Billable lines that round to nothing are dropped (warning rows always stay so the
 * tag/length problem keeps surfacing); each surviving billable line's start is
 * snapped to the nearest unit and packed forward so the displayed blocks never
 * overlap. `overtimeStripped` is the billable time (seconds) shaved off this day to
 * keep the week within the cap — reported separately, not part of the billed total.
 *
 * The total is billable-only: warning rows ride along as view hints (a tag/length
 * problem to fix in Toggl) but don't count toward what's billed, so the view total
 * matches the export — which omits the hint rows entirely.
 */
function finalizeDay(
  dayIdx: number,
  dateMs: number,
  { bill, warnRows, overlaps }: ClassifiedDay,
  roundingMs: number,
  overtimeStripped: number
): IndividualDay {
  const billKept = bill.filter((r) => r.rounded > 0);

  let cursor = -Infinity;
  for (const r of billKept) {
    let start = snapToUnit(r.groupStartMs, roundingMs);
    if (start < cursor) start = cursor;
    const end = start + r.rounded * 1000;
    r.startMs = start;
    r.endMs = end;
    cursor = end;
  }

  const rows = [...billKept, ...warnRows];
  const total = billKept.reduce((s, r) => s + r.rounded, 0);
  return { dayIdx, dateMs, rows, total, overlaps, overtime: overtimeStripped };
}

/**
 * Build the Individual view for one week: a list of days, each listing its
 * selected-project entries on their own rows with start–end time, rounded hours and
 * description. Returns null when there's no week to build (weekStart falsy).
 */
export function buildIndividualWeek({
  entries,
  weekStart,
  nowMs,
  projects,
  maxBillableHours,
  billingTagPrefix,
  roundingSeconds,
  noOvertime,
  weeklyHours,
  codeMappings,
}: IndividualInput): IndividualWeek | null {
  if (!weekStart) return null;
  const ids = new Set(projects.map((p) => p.id));
  const maxBillableSeconds = maxBillableHours * 3600;
  const roundingMs = roundingSeconds * 1000;
  const weekEnd = weekStart + 7 * DAY_MS;

  const byDay: DayEntry[][] = Array.from({ length: 7 }, () => []);
  for (const e of entries) {
    if (e.project_id == null || !ids.has(e.project_id)) continue;
    const startMs = new Date(e.start).getTime();
    if (!Number.isFinite(startMs) || startMs < weekStart || startMs >= weekEnd) continue;
    const dayIdx = Math.floor((startMs - weekStart) / DAY_MS);
    if (dayIdx < 0 || dayIdx > 6) continue;

    const running = e.duration < 0 || !e.stop;
    const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
    byDay[dayIdx].push({
      startMs,
      stopMs,
      seconds: Math.max(0, (stopMs - startMs) / 1000),
      projId: e.project_id,
      tags: e.tags,
      desc: e.description ?? '',
    });
  }

  const classified = byDay.map((dayEntries) =>
    classifyDay(dayEntries, maxBillableSeconds, billingTagPrefix, roundingSeconds, codeMappings)
  );

  // Close the linked-code aggregates at week level: one fixed billable block per
  // mapped project per day, rounded per code on the *mapping's* grid — and, when
  // the mapping declares the sub-client's own no-overtime contract, trimmed to
  // its weekly cap exactly as its own sheet would — so each block equals that
  // sheet's billed day total, with its per-code breakdown leading the
  // description. Anchored at the first mapped entry's start and sorted back into
  // time order with the native lines.
  const mappedWeeks = new Map<number, Map<number, MappedAgg>>(); // projId -> day -> agg
  classified.forEach((c, day) => {
    for (const [projId, agg] of c.mapped) {
      let byDayAgg = mappedWeeks.get(projId);
      if (!byDayAgg) {
        byDayAgg = new Map();
        mappedWeeks.set(projId, byDayAgg);
      }
      byDayAgg.set(day, agg);
    }
  });
  for (const [projId, byDayAgg] of mappedWeeks) {
    const mapping = mappingFor(codeMappings, projId)!;
    const values = finalizeMappedWeek(byDayAgg, mapping, weekStart);
    for (const [day, value] of values) {
      const agg = byDayAgg.get(day)!;
      classified[day].bill.push({
        key: `m${projId}`,
        kind: 'bill',
        code: mapping.targetCode,
        projId,
        seconds: agg.seconds,
        trimmableSeconds: 0,
        rounded: value.seconds,
        descs: value.descs,
        groupStartMs: agg.firstStartMs,
        fixed: true,
      });
      classified[day].bill.sort((a, b) => a.groupStartMs - b.groupStartMs);
    }
  }

  // Week-level overtime pass: if the contract disallows billing overtime and a
  // segment's billable lines exceed its cap, shave whole rounding units off them
  // (trimmable "(X)" portions first), spread proportionally over codes and days.
  // A month boundary mid-week splits the week into two independently-capped
  // segments; otherwise it's one full-week segment. Each line's `rounded` is
  // reduced in place and the per-day strip recorded.
  const overtimeByDay = new Array<number>(7).fill(0);
  if (noOvertime && weeklyHours > 0) {
    const toCell = (row: Row) => {
      const units = row.rounded / roundingSeconds;
      // The trimmable budget is the "(X)" share of this line's *rounded* units, so
      // a fully-"(X)" line is fully trimmable and a half-"(X)" line gives up half.
      const frac = row.seconds > 0 ? (row.trimmableSeconds ?? 0) / row.seconds : 0;
      return { units, trimmableUnits: Math.min(units, Math.round(units * frac)) };
    };
    for (const seg of weekSegments(weekStart, weeklyHours, roundingSeconds)) {
      // Fixed (linked-code) blocks are protected from the cut — they must keep
      // equalling the sub-client sheet's day totals — but still consume the cap,
      // so the trim takes that much more off the native lines instead.
      const flat: { row: Row; day: number }[] = [];
      let fixedUnits = 0;
      for (let day = seg.startDay; day <= seg.endDay; day++) {
        classified[day].bill.forEach((row) => {
          if (row.fixed) fixedUnits += Math.round(row.rounded / roundingSeconds);
          else flat.push({ row, day });
        });
      }
      const removed = allocateOvertimeTrim(
        flat.map(({ row }) => toCell(row)),
        Math.max(0, seg.capUnits - fixedUnits)
      );
      flat.forEach(({ row, day }, i) => {
        if (removed[i] > 0) {
          const strip = removed[i] * roundingSeconds;
          row.rounded -= strip;
          overtimeByDay[day] += strip;
        }
      });
    }
  }

  const days = classified
    .map((c, dayIdx) =>
      finalizeDay(dayIdx, weekStart + dayIdx * DAY_MS, c, roundingMs, overtimeByDay[dayIdx])
    )
    .filter((d) => d.rows.length > 0 || d.overlaps.length > 0 || d.overtime > 0);

  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  return { days, grandTotal };
}
