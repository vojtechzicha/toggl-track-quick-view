// Builder for the Individual timesheet. The on-screen view and the exporters
// both call it, so exports show the same lines as the screen.

import {
  addDays,
  fmtHoursLabel,
  fmtTimeOfDay,
  isTimeOffEntry,
  parseBillingCode,
  roundQuartersPreservingTotal,
  weekDayIndex,
  type TimeEntry,
} from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { allocateOvertimeTrim, weekSegments } from './overtime';
import { planBalance, segmentTargets, type BalanceCell } from './balance';
import {
  addToMappedAgg,
  entryBilling,
  finalizeMappedWeek,
  mappingFor,
  newMappedAgg,
  type CodeMapping,
  type MappedAgg,
} from './mapping';
import { billsTimeOff, sheetHolidays, timeOffBillingTags, type TimeOffRules } from './timeOff';
import { fitDescs } from './desc';
import { UNTAGGED, MULTIPLE, TOOLONG, projectBillingCode } from './constants';

const COMBINE_GAP_SECONDS = 60 * 60; // max gap between same-code entries that combine
const OVERLAP_MIN_MS = 60 * 1000; // shorter overlaps are not flagged

/** A selected-project entry for one day, with ms bounds. */
interface DayEntry {
  startMs: number;
  stopMs: number;
  seconds: number;
  projId: number | null;
  tags?: string[];
  desc: string;
  // Billed time off (see lib/timesheet/timeOff).
  timeOff: boolean;
}

export type WarnKind = typeof UNTAGGED | typeof MULTIPLE | typeof TOOLONG;

/** One line: a billable entry with a time span, or a warning aggregate. */
export interface Row {
  key: string;
  kind: 'bill' | 'warn';
  warn?: WarnKind;
  code?: string; // displayed billing code, markers stripped ('bill' rows)
  projId?: number | null; // 'bill' rows
  seconds: number; // before rounding
  trimmableSeconds?: number; // "(X)" share of `seconds`
  noTrimSeconds?: number; // "(!)" share of `seconds`, never trimmed
  rounded: number;
  startMs?: number; // displayed start, snapped to the grid ('bill' rows)
  endMs?: number; // start + rounded duration
  descs: string[];
  // Display, copy and export text: `descs` joined with "; ". Billable rows are
  // fitted to the length limit (lib/timesheet/desc); warning rows are not,
  // because their text identifies the entries to fix.
  desc: string;
  // True when the limit dropped or cut something. `descs` keeps every part.
  descTruncated: boolean;
  groupStartMs: number; // first raw start; the displayed start snaps from it
  // A linked-code day block. `rounded` is fixed by the mapping (see
  // lib/timesheet/mapping); it is never re-rounded, trimmed or checked against
  // the length cap here.
  fixed?: boolean;
  // A billed time-off line (see lib/timesheet/timeOff). Also `fixed`: it is
  // rounded on its own, then never trimmed, moved or checked against the cap.
  timeOff?: boolean;
}

export interface IndividualDay {
  dayIdx: number;
  dateMs: number;
  rows: Row[];
  total: number;
  overlaps: string[];
  // Seconds trimmed from this day by the overtime cap. Not part of `total`.
  overtime: number;
  // Billed seconds this day gained (positive) or gave (negative) when
  // balancing working days. Already part of `total`.
  balanced: number;
  // True when the day has a time-off entry.
  holiday: boolean;
  // True when one of them bills, so the day keeps its share of the cap.
  holidayBilled: boolean;
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
  // Rounding unit in seconds (e.g. 900 = 15 min, 720 = 12 min).
  roundingSeconds: number;
  // Grid for displayed start times, in seconds (see startWindowUnitSeconds).
  // Absent or finer than the rounding unit means the rounding unit.
  startWindowSeconds?: number | null;
  // Character limit for each billable row's description. null or absent means
  // no limit.
  maxDescriptionLength?: number | null;
  // When true, the billed total is trimmed to `weeklyHours` and the trimmed
  // time is shown as an "Overtime" line. When false, `weeklyHours` is unused.
  noOvertime: boolean;
  weeklyHours: number;
  // Move billed time between working weekdays so each reaches weeklyHours / 5
  // (see lib/timesheet/balance). Absent means off.
  balanceWeekdays?: boolean;
  // Tag marking a time-off entry (see isTimeOffEntry). Empty or absent means
  // the default.
  timeOffTag?: string;
  // Projects that bill as one fixed block per day (see lib/timesheet/mapping).
  codeMappings?: CodeMapping[];
  // Drop parenthetical groups from codes ("D123 (Phase 2)" → "D123"), after the
  // markers are read. Codes that differ only there combine.
  stripCodeParens?: boolean;
  // Bill every entry to its project, whose name is the line's code. Billing
  // codes, support tickets, markers, the parentheses strip and linked codes do
  // not apply; the length cap and overlap warnings still do.
  billByProject?: boolean;
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

// Grid marks are measured from local midnight, not the epoch. An epoch-aligned
// hourly grid lands on :30 in UTC+05:30. Anchoring to local midnight gives real
// clock marks in every zone.

/** Local midnight of the day `ms` falls on: the grid's anchor. */
function dayAnchor(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The local midnight ending the day that starts at `anchor` (23–25h later across DST). */
function dayEnd(anchor: number): number {
  const d = new Date(anchor);
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Snap a time to the nearest mark of the grid running from `anchor`. */
function snapToUnit(ms: number, unitMs: number, anchor: number): number {
  return anchor + Math.round((ms - anchor) / unitMs) * unitMs;
}

/** The first mark of that grid at or after `ms`. */
function ceilToUnit(ms: number, unitMs: number, anchor: number): number {
  return anchor + Math.ceil((ms - anchor) / unitMs) * unitMs;
}

/** The last mark of that grid at or before `ms`. */
function floorToUnit(ms: number, unitMs: number, anchor: number): number {
  return anchor + Math.floor((ms - anchor) / unitMs) * unitMs;
}

/** A day split into billable lines and warning aggregates, rounded. */
interface ClassifiedDay {
  bill: Row[];
  warnRows: Row[];
  overlaps: string[];
  // Linked-code aggregates by project id. They are finalized per week in
  // buildIndividualWeek, because the mapping may have its own weekly cap.
  mapped: Map<number, MappedAgg>;
}

/**
 * Split one day's entries into billable lines and warning aggregates, and round
 * them.
 *
 * Consecutive same-code entries on the same project combine while the gap is at
 * most an hour and the total stays within the billable cap. Rounding preserves
 * the day total, biased so small entries are not rounded away. Lines rounded to
 * zero are kept, and start times are not set; finalizeDay does both after the
 * week's overtime trim.
 */
function classifyDay(
  dayEntries: DayEntry[],
  maxBillableSeconds: number,
  billingTagPrefix: string,
  roundingSeconds: number,
  codeMappings?: CodeMapping[],
  stripCodeParens?: boolean,
  // Projects-only billing: the project name (from `nameById`) is the code.
  billByProject?: boolean,
  nameById?: Map<number, string>,
  timeOffRules?: TimeOffRules
): ClassifiedDay {
  const sorted = [...dayEntries].sort((a, b) => a.startMs - b.startMs);

  // Overlapping entries cannot both be billed, so flag them. Sorted by start, so
  // the inner loop can stop at the first entry starting after this one ends.
  const overlaps: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].startMs >= sorted[i].stopMs) break;
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
      row = { key: kind, kind: 'warn', warn: kind, seconds: 0, rounded: 0, descs: [], desc: '', descTruncated: false, groupStartMs: e.startMs };
      warnBuckets[kind] = row;
    }
    row.seconds += e.seconds;
    mergeDesc(row.descs, e.desc);
  };

  let current: Row | null = null; // billable line being combined into
  let lastStopMs = 0; // stop of the last entry added to `current`
  const flush = () => {
    current = null;
  };

  // Linked-code aggregates, one per mapped project this day.
  const mappedByProj = new Map<number, MappedAgg>();
  // Billed time-off lines, rounded apart from the work below.
  const timeOff: Row[] = [];

  for (const e of sorted) {
    if (e.timeOff) {
      // Never combined with anything and exempt from the billable-length cap.
      // Markers mean nothing here: time off is never trimmed.
      flush();
      const tags = timeOffBillingTags(e.tags, timeOffRules as TimeOffRules);
      if (tags.length > 1) {
        addWarn(MULTIPLE, e);
        continue;
      }
      const row: Row = {
        key: `t${e.startMs}`,
        kind: 'bill',
        code: parseBillingCode(tags[0], stripCodeParens).base,
        projId: e.projId,
        seconds: e.seconds,
        trimmableSeconds: 0,
        noTrimSeconds: 0,
        rounded: 0,
        descs: [],
        desc: '',
        descTruncated: false,
        groupStartMs: e.startMs,
        fixed: true,
        timeOff: true,
      };
      mergeDesc(row.descs, e.desc);
      timeOff.push(row);
      continue;
    }
    // A mapped project's tags use the mapping's prefix. With billByProject the
    // project name is the only "tag" and the description is used as is.
    const mapping = billByProject ? undefined : mappingFor(codeMappings, e.projId);
    const { tags, description } = billByProject
      ? {
          tags: [projectBillingCode(nameById?.get(e.projId as number), e.projId as number)],
          description: e.desc,
        }
      : entryBilling(e.tags, e.desc, mapping, billingTagPrefix);
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
      // Linked code: add to the project's day aggregate. The billable cap does
      // not apply to it, as it is a whole-day total.
      flush();
      let agg = mappedByProj.get(e.projId as number);
      if (!agg) {
        agg = newMappedAgg(e.startMs);
        mappedByProj.set(e.projId as number, agg);
      }
      addToMappedAgg(agg, tags[0], e.seconds, description, e.startMs);
      continue;
    }
    if (e.seconds > maxBillableSeconds) {
      flush();
      addWarn(TOOLONG, e); // an entry is never split
      continue;
    }

    // Marked codes combine with their plain base; the same code on two projects
    // does not. A project name is never parsed, so a name ending in "(X)" is not
    // a marker.
    const { base, trimmable, neverTrim } = billByProject
      ? { base: tags[0], trimmable: false, neverTrim: false }
      : parseBillingCode(tags[0], stripCodeParens);
    const canCombine =
      current !== null &&
      current.code === base &&
      current.projId === e.projId &&
      e.startMs - lastStopMs <= COMBINE_GAP_SECONDS * 1000 &&
      current.seconds + e.seconds <= maxBillableSeconds;

    if (canCombine && current) {
      current.seconds += e.seconds;
      if (trimmable) current.trimmableSeconds = (current.trimmableSeconds ?? 0) + e.seconds;
      if (neverTrim) current.noTrimSeconds = (current.noTrimSeconds ?? 0) + e.seconds;
      mergeDesc(current.descs, description);
    } else {
      current = {
        key: `b${e.startMs}`,
        kind: 'bill',
        code: base,
        projId: e.projId,
        seconds: e.seconds,
        trimmableSeconds: trimmable ? e.seconds : 0,
        noTrimSeconds: neverTrim ? e.seconds : 0,
        rounded: 0,
        descs: [],
        desc: '',
        descTruncated: false,
        groupStartMs: e.startMs,
      };
      mergeDesc(current.descs, description);
      bill.push(current);
    }
    lastStopMs = e.stopMs;
  }

  // Round billable lines and warning rows together, biased toward would-be
  // zeros. Linked-code aggregates are rounded on their own grid later.
  const warnRows = ([UNTAGGED, MULTIPLE, TOOLONG] as WarnKind[])
    .map((k) => warnBuckets[k])
    .filter((r): r is Row => r !== null);
  const allRows = [...bill, ...warnRows];
  const rounded = roundQuartersPreservingTotal(
    allRows.map((r) => r.seconds),
    { biasZero: true, unitSeconds: roundingSeconds }
  );
  allRows.forEach((r, i) => (r.rounded = rounded[i]));
  const offRounded = roundQuartersPreservingTotal(
    timeOff.map((r) => r.seconds),
    { unitSeconds: roundingSeconds }
  );
  timeOff.forEach((r, i) => (r.rounded = offRounded[i]));
  if (timeOff.length > 0) {
    bill.push(...timeOff);
    bill.sort((a, b) => a.groupStartMs - b.groupStartMs);
  }

  return { bill, warnRows, overlaps, mapped: mappedByProj };
}

/**
 * Turn a classified, possibly trimmed day into its rows.
 *
 * Billable lines rounded to zero are dropped; warning rows always stay. Each
 * billable line's start snaps to the nearest mark of the start-time grid
 * (`windowMs`, from local midnight) and lines are packed forward so they never
 * overlap. A line pushed past its mark moves to the next mark, so on a window
 * coarser than the rounding unit this leaves a gap instead of an off-grid start.
 *
 * `total` excludes warning rows, matching the export, which omits them.
 * `overtimeStripped` is the time trimmed from this day, and `balanced` the time
 * it gained or gave when balancing, in seconds.
 */
function finalizeDay(
  dayIdx: number,
  dateMs: number,
  { bill, warnRows, overlaps }: ClassifiedDay,
  windowMs: number,
  overtimeStripped: number,
  balanced: number,
  maxDescLen: number | null | undefined,
  holiday: boolean,
  holidayBilled: boolean
): IndividualDay {
  const billKept = bill.filter((r) => r.rounded > 0);

  let cursor = -Infinity;
  for (const r of billKept) {
    const anchor = dayAnchor(r.groupStartMs);
    // Keep the snapped start on the entry's day: 23:40 on an hourly grid would
    // snap to tomorrow and export under the wrong date, so use the day's last
    // mark instead.
    const lastMark = floorToUnit(dayEnd(anchor) - 1, windowMs, anchor);
    let start = Math.min(snapToUnit(r.groupStartMs, windowMs, anchor), lastMark);
    // Packing takes priority over that clamp: a full day runs past midnight
    // rather than stacking two lines on one mark. When the window equals the
    // rounding unit, `cursor` is already on the grid and the ceil is a no-op.
    if (start < cursor) start = ceilToUnit(cursor, windowMs, anchor);
    const end = start + r.rounded * 1000;
    r.startMs = start;
    r.endMs = end;
    cursor = end;
  }

  // Fit billable descriptions to the length limit. Warning rows keep the full
  // text.
  for (const r of billKept) {
    const fitted = fitDescs(r.descs, maxDescLen);
    r.desc = fitted.text;
    r.descTruncated = fitted.truncated;
  }
  for (const r of warnRows) r.desc = r.descs.join('; ');

  const rows = [...billKept, ...warnRows];
  const total = billKept.reduce((s, r) => s + r.rounded, 0);
  return {
    dayIdx,
    dateMs,
    rows,
    total,
    overlaps,
    overtime: overtimeStripped,
    balanced,
    holiday,
    holidayBilled,
  };
}

/**
 * Build the Individual view for one week: per day, one row per billable line
 * with start–end time, rounded hours and description. Returns null when
 * weekStart is falsy.
 */
export function buildIndividualWeek({
  entries,
  weekStart,
  nowMs,
  projects,
  maxBillableHours,
  billingTagPrefix,
  roundingSeconds,
  startWindowSeconds,
  maxDescriptionLength,
  noOvertime,
  weeklyHours,
  balanceWeekdays,
  timeOffTag,
  codeMappings,
  stripCodeParens,
  billByProject,
}: IndividualInput): IndividualWeek | null {
  if (!weekStart) return null;
  const ids = new Set(projects.map((p) => p.id));
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const maxBillableSeconds = maxBillableHours * 3600;
  // Start-time grid: the window when coarser than the rounding unit, else the
  // rounding unit.
  const windowMs =
    Math.max(roundingSeconds, startWindowSeconds && startWindowSeconds > 0 ? startWindowSeconds : 0) *
    1000;
  const weekEnd = addDays(weekStart, 7);

  // `holidays` marks the days; `billingHolidays` drives the cap and the
  // balancing, and leaves out days with billed time off.
  const timeOffRules = { timeOffTag, billingTagPrefix, codeMappings, billByProject };
  const {
    holidays,
    billed: billedHolidays,
    billing: billingHolidays,
  } = sheetHolidays(entries, ids, weekStart, timeOffRules);

  const byDay: DayEntry[][] = Array.from({ length: 7 }, () => []);
  for (const e of entries) {
    if (e.project_id == null || !ids.has(e.project_id)) continue;
    const startMs = new Date(e.start).getTime();
    if (!Number.isFinite(startMs) || startMs < weekStart || startMs >= weekEnd) continue;
    const dayIdx = weekDayIndex(new Date(startMs));
    // A time-off marker only marks the day. With a billing tag it also bills,
    // as its own line.
    const timeOff = billsTimeOff(e.tags, e.project_id, timeOffRules);
    if (!timeOff && isTimeOffEntry(e.tags, timeOffTag)) continue;

    const running = e.duration < 0 || !e.stop;
    const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
    byDay[dayIdx].push({
      startMs,
      stopMs,
      seconds: Math.max(0, (stopMs - startMs) / 1000),
      projId: e.project_id,
      tags: e.tags,
      desc: e.description ?? '',
      timeOff,
    });
  }

  const classified = byDay.map((dayEntries) =>
    classifyDay(
      dayEntries,
      maxBillableSeconds,
      billingTagPrefix,
      roundingSeconds,
      codeMappings,
      stripCodeParens,
      billByProject,
      nameById,
      timeOffRules
    )
  );

  // One fixed block per mapped project per day (finalizeMappedWeek), placed at
  // its first entry's start and sorted in with the native lines.
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
    const values = finalizeMappedWeek(byDayAgg, mapping, weekStart, billingHolidays);
    for (const [day, value] of values) {
      const agg = byDayAgg.get(day)!;
      classified[day].bill.push({
        key: `m${projId}`,
        kind: 'bill',
        code: mapping.targetCode,
        projId,
        seconds: agg.seconds,
        trimmableSeconds: 0,
        noTrimSeconds: 0,
        rounded: value.seconds,
        descs: value.descs,
        desc: '',
        descTruncated: false,
        groupStartMs: agg.firstStartMs,
        fixed: true,
      });
      classified[day].bill.sort((a, b) => a.groupStartMs - b.groupStartMs);
    }
  }

  // Overtime cap per segment (see lib/timesheet/overtime), cut proportionally
  // across all lines. `rounded` is reduced in place.
  const overtimeByDay = new Array<number>(7).fill(0);
  if (noOvertime && weeklyHours > 0) {
    const toCell = (row: Row) => {
      const units = row.rounded / roundingSeconds;
      // "(X)" and "(!)" shares of the rounded units, kept disjoint.
      const frac = row.seconds > 0 ? (row.trimmableSeconds ?? 0) / row.seconds : 0;
      const trimmableUnits = Math.min(units, Math.round(units * frac));
      const fracKeep = row.seconds > 0 ? (row.noTrimSeconds ?? 0) / row.seconds : 0;
      const noTrimUnits = Math.min(units - trimmableUnits, Math.round(units * fracKeep));
      return { units, trimmableUnits, noTrimUnits };
    };
    for (const seg of weekSegments(weekStart, weeklyHours, roundingSeconds, billingHolidays)) {
      // Linked-code blocks and time-off lines count toward the cap but are
      // never cut.
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

  // Balance the working days (see lib/timesheet/balance). A day gives from its
  // latest lines first. The time becomes a new line on the receiving day, with
  // the same code and description, at the same time of day or after that day's
  // last line, whichever is later. Linked blocks and time-off lines count
  // toward their day but never move.
  const balancedByDay = new Array<number>(7).fill(0);
  if (balanceWeekdays && weeklyHours > 0) {
    for (const seg of weekSegments(weekStart, weeklyHours, roundingSeconds, billingHolidays)) {
      const targets = segmentTargets(seg, billingHolidays);
      const lines: { row: Row; day: number }[] = [];
      const balCells: BalanceCell[] = [];
      for (const day of targets.keys()) {
        for (const row of [...classified[day].bill].reverse()) {
          const units = Math.round(row.rounded / roundingSeconds);
          if (units <= 0) continue;
          lines.push({ row, day });
          balCells.push({ day, units, fixed: row.fixed });
        }
      }
      for (const m of planBalance(balCells, targets)) {
        const { row, day } = lines[m.cell];
        const secs = m.units * roundingSeconds;
        row.rounded -= secs;
        balancedByDay[day] -= secs;
        balancedByDay[m.toDay] += secs;
        // Appended, so finalizeDay packs it after the day's existing lines.
        const at = new Date(addDays(weekStart, m.toDay));
        const src = new Date(row.groupStartMs);
        at.setHours(src.getHours(), src.getMinutes(), src.getSeconds(), src.getMilliseconds());
        classified[m.toDay].bill.push({
          key: `${row.key}>${m.toDay}`,
          kind: 'bill',
          code: row.code,
          projId: row.projId,
          seconds: secs,
          trimmableSeconds: 0,
          noTrimSeconds: 0,
          rounded: secs,
          descs: [...row.descs],
          desc: '',
          descTruncated: false,
          groupStartMs: at.getTime(),
        });
      }
    }
  }

  const days = classified
    .map((c, dayIdx) =>
      finalizeDay(
        dayIdx,
        addDays(weekStart, dayIdx),
        c,
        windowMs,
        overtimeByDay[dayIdx],
        balancedByDay[dayIdx],
        maxDescriptionLength,
        holidays.has(dayIdx),
        billedHolidays.has(dayIdx)
      )
    )
    // Show a weekday holiday even with no entries, since it explains the lower
    // cap. A weekend marker changes nothing and is not shown. A day that gave
    // all its time away when balancing (possible when a target is 0) still
    // shows, so the move is visible on both ends.
    .filter(
      (d) =>
        d.rows.length > 0 ||
        d.overlaps.length > 0 ||
        d.overtime > 0 ||
        d.balanced !== 0 ||
        (d.holiday && d.dayIdx >= 2)
    );

  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  return { days, grandTotal };
}
