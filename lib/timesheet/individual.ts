// Pure builder for the Individual timesheet view. Shared by the on-screen
// IndividualTimesheet component and the exporters so they show identical figures
// (same same-code combining, same biased quarter-hour rounding, same time anchoring).

import {
  fmtHoursLabel,
  fmtTimeOfDay,
  holidayDaysOfWeek,
  isTimeOffEntry,
  parseBillingCode,
  roundQuartersPreservingTotal,
  type TimeEntry,
} from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import { allocateOvertimeTrim, weekSegments } from './overtime';
import {
  addToMappedAgg,
  entryBilling,
  finalizeMappedWeek,
  mappingFor,
  newMappedAgg,
  type CodeMapping,
  type MappedAgg,
} from './mapping';
import { fitDescs } from './desc';
import { DAY_MS, UNTAGGED, MULTIPLE, TOOLONG, projectBillingCode } from './constants';

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
  noTrimSeconds?: number; // of `seconds`, how much came from "(!)"-marked entries (never trimmed)
  rounded: number; // filled in after rounding
  startMs?: number; // anchored display start (bill rows, after rounding)
  endMs?: number; // start + rounded duration
  descs: string[];
  // The row's display/copy/export description: `descs` joined with "; " and — on
  // billable rows — fitted within the optional length limit (see lib/timesheet/desc).
  // Warning rows are never limited: their text is the pointer to the entries to fix.
  desc: string;
  // True when the limit dropped/cut something; `descs` still holds the full parts.
  descTruncated: boolean;
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
  // True when the day carries a time-off entry (state holiday etc.): a
  // non-working day — the weekly cap dropped by a day's worth because of it.
  holiday: boolean;
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
  // The grid a line's displayed start time is anchored to, in seconds. Absent or
  // finer than the rounding unit = the rounding unit itself (times and rounding
  // linked, the default). A coarser window serves clients that take finely rounded
  // durations but only accept starts on their own grid (e.g. 15-min durations that
  // may only begin at :00 or :30).
  startWindowSeconds?: number | null;
  // Optional cap (characters) on each billable row's merged description; the
  // client's system rejects longer messages. null/absent = no limit.
  maxDescriptionLength?: number | null;
  // When true, the week's billable total is trimmed down to `weeklyHours` (the
  // contract disallows billing overtime); the trimmed time surfaces as an
  // "Overtime" line. When false, neither input has any effect.
  noOvertime: boolean;
  weeklyHours: number;
  // The tag marking a time-off entry (state holiday etc.). Such an entry turns
  // its day into a non-working day (like a weekend: no cap budget, no target)
  // and is itself never billed or shown. Empty/absent falls back to the default.
  timeOffTag?: string;
  // Linked billing codes: projects whose entries carry another client's tags and
  // bill here as one fixed day block per project (see lib/timesheet/mapping).
  codeMappings?: CodeMapping[];
  // When true, billing codes drop their parenthetical groups ("D123 (Phase 2)"
  // lines as "D123") — after the "(X)"/"(!)" markers are interpreted, so those
  // keep working. Codes differing only in the parenthetical combine as one code.
  stripCodeParens?: boolean;
  // When true, this workspace doesn't use billing codes: every entry bills to
  // its PROJECT, whose name is the line's code. Nothing can be untagged or
  // multi-tagged, and none of the billing-code machinery applies — no support
  // tickets, no "(X)"/"(!)" markers, no parentheses strip, no linked codes.
  // The length cap and the overlap warnings still apply — they're about time,
  // not codes.
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

// Grid marks are measured from the day's own local midnight, not from the epoch:
// a grid the epoch aligns to is only the *local* clock's grid where the zone's
// offset happens to be a whole multiple of the unit. In UTC+05:30 an hourly grid
// laid over the epoch lands on :30 — the times a client is promised on the hour
// would all be half past. Anchoring to local midnight makes the marks true clock
// marks in every zone (and keeps them so across a DST shift within the day).

/** Local midnight of the day `ms` falls on — the grid's anchor. */
function dayAnchor(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The local midnight that ends the day starting at `anchor` (DST-safe: 23–25h). */
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
  codeMappings?: CodeMapping[],
  stripCodeParens?: boolean,
  // Projects-only billing: the project name (from `nameById`) is the line's
  // code and the tag/ticket/marker machinery is bypassed entirely.
  billByProject?: boolean,
  nameById?: Map<number, string>
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
      row = { key: kind, kind: 'warn', warn: kind, seconds: 0, rounded: 0, descs: [], desc: '', descTruncated: false, groupStartMs: e.startMs };
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
    // its untagged/multi-tagged entries surface in the same warning rows. An
    // untagged entry whose description opens with "[ticket]" bills to that
    // ticket instead of warning (support tickets — see entryBilling), with the
    // bracket dropped from the billed description.
    //
    // With projects-only billing the entry's PROJECT is its billing line: the
    // project name stands in as the single "tag" (so nothing can be untagged or
    // multi-tagged), the description passes through verbatim (no ticket
    // bracket), and mappings are ignored — a linked code is billing-code
    // machinery this workspace doesn't use.
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
      // Linked code: fold into the project's day aggregate. The billable-length
      // cap doesn't apply — the block is an aggregate of the whole day by design,
      // like a Summary cell, not an individually billed entry.
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
      addWarn(TOOLONG, e); // a single oversize entry can't be split
      continue;
    }

    // The "(X)" / "(!)" markers are just trim *versions* of the same billing code,
    // so they merge into their plain twin: one displayed line, with the "(X)"
    // seconds tracked separately as the trim budget and the "(!)" seconds as the
    // untouchable floor. Same code under two different projects still stays
    // separate (a project is a group of billing tags). The parenthetical strip
    // (when the workspace opts in) runs after the marker interpretation.
    // A projects-only line is the project name verbatim — a name that happens to
    // end in "(X)" is just a name, never a marker, and nothing there is trimmable
    // or protected.
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
 * snapped to the nearest mark of the start-time grid (`windowMs` — the rounding unit
 * unless the workspace anchors starts to a coarser window) and packed forward so the
 * displayed blocks never overlap. The grid is the *local* clock's, running from the
 * day's midnight, and a line's own mark stays inside that day. Packing keeps a line
 * on the grid too: a block pushed past its own mark moves on to the *next* one, which
 * on a window coarser than the rounding unit leaves a gap rather than an off-grid
 * start. `overtimeStripped` is the billable time (seconds) shaved off this day to
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
  windowMs: number,
  overtimeStripped: number,
  maxDescLen: number | null | undefined,
  holiday: boolean
): IndividualDay {
  const billKept = bill.filter((r) => r.rounded > 0);

  let cursor = -Infinity;
  for (const r of billKept) {
    // The grid runs from the local midnight of the day the entry was tracked on.
    const anchor = dayAnchor(r.groupStartMs);
    // A line's own mark never leaves that day: a late entry whose nearest mark is
    // already tomorrow (23:40 on an hourly grid) falls back to the day's last mark
    // instead of being displayed — and exported — under the wrong date.
    const lastMark = floorToUnit(dayEnd(anchor) - 1, windowMs, anchor);
    let start = Math.min(snapToUnit(r.groupStartMs, windowMs, anchor), lastMark);
    // Packing still wins over that clamp: a day whose rounded lines genuinely fill
    // it runs past midnight rather than stacking two lines on the same mark.
    // When the window equals the rounding unit the ceiling is a no-op — `cursor`
    // is a mark plus whole rounding units — so linked grids pack exactly as before.
    if (start < cursor) start = ceilToUnit(cursor, windowMs, anchor);
    const end = start + r.rounded * 1000;
    r.startMs = start;
    r.endMs = end;
    cursor = end;
  }

  // Close each row's display description: billable rows are fitted within the
  // optional length limit (this is the text that goes to the client's system);
  // warning rows keep the full join — it's the pointer to the entries to fix.
  for (const r of billKept) {
    const fitted = fitDescs(r.descs, maxDescLen);
    r.desc = fitted.text;
    r.descTruncated = fitted.truncated;
  }
  for (const r of warnRows) r.desc = r.descs.join('; ');

  const rows = [...billKept, ...warnRows];
  const total = billKept.reduce((s, r) => s + r.rounded, 0);
  return { dayIdx, dateMs, rows, total, overlaps, overtime: overtimeStripped, holiday };
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
  startWindowSeconds,
  maxDescriptionLength,
  noOvertime,
  weeklyHours,
  timeOffTag,
  codeMappings,
  stripCodeParens,
  billByProject,
}: IndividualInput): IndividualWeek | null {
  if (!weekStart) return null;
  const ids = new Set(projects.map((p) => p.id));
  const nameById = new Map(projects.map((p) => [p.id, p.name]));
  const maxBillableSeconds = maxBillableHours * 3600;
  // Durations round on the rounding unit; start times anchor to the window, which
  // is the same grid unless the workspace picked a coarser one. A finer window would
  // be meaningless (a rounded block can't start off the unit it's measured in), so
  // it collapses back to the rounding unit.
  const windowMs =
    Math.max(roundingSeconds, startWindowSeconds && startWindowSeconds > 0 ? startWindowSeconds : 0) *
    1000;
  const weekEnd = weekStart + 7 * DAY_MS;

  // Days marked as time off by a selected project's entry: non-working days for
  // the overtime cap below. The marker entries themselves never bill (skipped in
  // the loop); other entries on such a day still bill — in full, like weekend work.
  const holidays = holidayDaysOfWeek(entries, ids, weekStart, timeOffTag);

  const byDay: DayEntry[][] = Array.from({ length: 7 }, () => []);
  for (const e of entries) {
    if (e.project_id == null || !ids.has(e.project_id)) continue;
    const startMs = new Date(e.start).getTime();
    if (!Number.isFinite(startMs) || startMs < weekStart || startMs >= weekEnd) continue;
    const dayIdx = Math.floor((startMs - weekStart) / DAY_MS);
    if (dayIdx < 0 || dayIdx > 6) continue;
    // The time-off marker only classifies its day (see `holidays` above) — the
    // entry itself is never billed, warned about, or shown.
    if (isTimeOffEntry(e.tags, timeOffTag)) continue;

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
    classifyDay(
      dayEntries,
      maxBillableSeconds,
      billingTagPrefix,
      roundingSeconds,
      codeMappings,
      stripCodeParens,
      billByProject,
      nameById
    )
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
    const values = finalizeMappedWeek(byDayAgg, mapping, weekStart, holidays);
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

  // Week-level overtime pass: if the contract disallows billing overtime and a
  // segment's billable lines exceed its cap, shave whole rounding units off them
  // (trimmable "(X)" portions first), spread proportionally over codes and days.
  // A holiday shrinks the segment's cap by a day's worth (weeklyHours / 5, see
  // weekSegments), so a 40h week with a state holiday caps at 32h. A month
  // boundary mid-week splits the week into two independently-capped segments;
  // otherwise it's one full-week segment. Each line's `rounded` is reduced in
  // place and the per-day strip recorded.
  const overtimeByDay = new Array<number>(7).fill(0);
  if (noOvertime && weeklyHours > 0) {
    const toCell = (row: Row) => {
      const units = row.rounded / roundingSeconds;
      // The trimmable budget is the "(X)" share of this line's *rounded* units, so
      // a fully-"(X)" line is fully trimmable and a half-"(X)" line gives up half.
      // The protected floor is its "(!)" share, capped so the shares can't overlap.
      const frac = row.seconds > 0 ? (row.trimmableSeconds ?? 0) / row.seconds : 0;
      const trimmableUnits = Math.min(units, Math.round(units * frac));
      const fracKeep = row.seconds > 0 ? (row.noTrimSeconds ?? 0) / row.seconds : 0;
      const noTrimUnits = Math.min(units - trimmableUnits, Math.round(units * fracKeep));
      return { units, trimmableUnits, noTrimUnits };
    };
    for (const seg of weekSegments(weekStart, weeklyHours, roundingSeconds, holidays)) {
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
      finalizeDay(
        dayIdx,
        weekStart + dayIdx * DAY_MS,
        c,
        windowMs,
        overtimeByDay[dayIdx],
        maxDescriptionLength,
        holidays.has(dayIdx)
      )
    )
    // A weekday holiday stays visible even when the marker was its only entry —
    // the empty day block with its "holiday" pill is what explains the shrunken
    // weekly cap. (A weekend marker changes nothing, so it isn't surfaced.)
    .filter(
      (d) =>
        d.rows.length > 0 || d.overlaps.length > 0 || d.overtime > 0 || (d.holiday && d.dayIdx >= 2)
    );

  const grandTotal = days.reduce((s, d) => s + d.total, 0);
  return { days, grandTotal };
}
