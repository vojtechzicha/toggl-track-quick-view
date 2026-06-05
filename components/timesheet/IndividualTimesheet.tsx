'use client';

import { useMemo } from 'react';
import {
  billingTagsOf,
  startOfWeekMonday,
  fmtHours,
  fmtTimeOfDay,
  roundQuartersPreservingTotal,
  QUARTER_SECONDS,
  MAX_BILLABLE_HOURS,
} from '@/lib/calc';
import type { TimesheetViewProps } from './types';
import CopyButton from './CopyButton';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MS = 24 * 3600 * 1000;
const QUARTER_MS = QUARTER_SECONDS * 1000;
const MAX_BILLABLE_SECONDS = MAX_BILLABLE_HOURS * 3600;
const COMBINE_GAP_SECONDS = 60 * 60; // combine same-code entries only within this gap
const OVERLAP_MIN_MS = 60 * 1000; // ignore sub-minute touches (display/manual-entry noise)

// Warning buckets — entries that can't become a normal billable line and are
// surfaced as amber aggregate rows (mirrors the summary view's warning rows).
const UNTAGGED = 'untagged'; // no billing tag
const MULTIPLE = 'multiple'; // more than one billing tag — ambiguous
const TOOLONG = 'toolong'; // a single entry longer than 4h — can't be billed individually

/** A raw selected-project entry for one day, normalised to ms bounds. */
interface DayEntry {
  startMs: number;
  stopMs: number;
  seconds: number;
  tags?: string[];
  desc: string;
}

type WarnKind = typeof UNTAGGED | typeof MULTIPLE | typeof TOOLONG;

/** One rendered line: a billable entry (with a time span) or a warning aggregate. */
interface Row {
  key: string;
  kind: 'bill' | 'warn';
  warn?: WarnKind;
  code?: string; // billing tag, for 'bill' rows
  seconds: number; // raw, pre-rounding
  rounded: number; // filled in after rounding
  startMs?: number; // anchored display start (bill rows, after rounding)
  endMs?: number; // start + rounded duration
  descs: string[];
  groupStartMs: number; // first raw start, used to anchor the display time
}

const WARN_LABEL: Record<WarnKind, string> = {
  [UNTAGGED]: 'No billing tag',
  [MULTIPLE]: 'Multiple billing tags',
  [TOOLONG]: 'Too long to bill individually (> 4h)',
};

function mergeDesc(into: string[], desc: string) {
  const text = desc.trim();
  if (!text) return;
  if (into.some((d) => d.toLowerCase() === text.toLowerCase())) return;
  into.push(text);
}

/** Snap an absolute time to the nearest 15-minute clock mark. */
function snapQuarter(ms: number): number {
  return Math.round(ms / QUARTER_MS) * QUARTER_MS;
}

/**
 * Build one day's rows from its selected-project entries.
 *
 * Entries are classified, then consecutive same-code entries are combined while
 * the gap stays within an hour and the combined duration stays billable (<= 4h).
 * Durations are rounded to 15-minute units preserving the day total (biased so a
 * tiny entry surfaces rather than vanishing; a billable line still at zero is
 * dropped). Finally each billable line's start is snapped to the nearest quarter
 * and packed forward so the displayed blocks never overlap.
 */
function buildDay(dayEntries: DayEntry[]) {
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

  for (const e of sorted) {
    const tags = billingTagsOf(e.tags);
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
    if (e.seconds > MAX_BILLABLE_SECONDS) {
      flush();
      addWarn(TOOLONG, e); // a single oversize entry can't be split
      continue;
    }

    const code = tags[0];
    const canCombine =
      current !== null &&
      current.code === code &&
      e.startMs - lastStopMs <= COMBINE_GAP_SECONDS * 1000 &&
      current.seconds + e.seconds <= MAX_BILLABLE_SECONDS;

    if (canCombine && current) {
      current.seconds += e.seconds;
      mergeDesc(current.descs, e.desc);
    } else {
      current = {
        key: `b${e.startMs}`,
        kind: 'bill',
        code,
        seconds: e.seconds,
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
  // small entries surface (a billable line still at zero is then dropped).
  const warnRows = ([UNTAGGED, MULTIPLE, TOOLONG] as WarnKind[])
    .map((k) => warnBuckets[k])
    .filter((r): r is Row => r !== null);
  const allRows = [...bill, ...warnRows];
  const rounded = roundQuartersPreservingTotal(
    allRows.map((r) => r.seconds),
    { biasZero: true }
  );
  allRows.forEach((r, i) => (r.rounded = rounded[i]));

  // Drop billable lines that still round to nothing; warning rows always stay so
  // the tag/length problem keeps surfacing even when its time is negligible.
  const billKept = bill.filter((r) => r.rounded > 0);

  // Anchor each billable line's start to the nearest quarter and pack forward so
  // the displayed blocks never overlap, even after rounding. The end is the
  // start plus the rounded duration.
  let cursor = -Infinity;
  for (const r of billKept) {
    let start = snapQuarter(r.groupStartMs);
    if (start < cursor) start = cursor;
    const end = start + r.rounded * 1000;
    r.startMs = start;
    r.endMs = end;
    cursor = end;
  }

  const rows = [...billKept, ...warnRows];
  const total = allRows.reduce((s, r) => s + r.rounded, 0);
  return { rows, total, overlaps };
}

/**
 * Individual view: the week as a list of days, each listing its selected-project
 * entries on their own rows with start–end time, rounded hours and description.
 * Consecutive same-code entries combine (within an hour, capped at 4h); tag and
 * length problems surface as amber warning rows, and raw-time overlaps are
 * flagged so they can be fixed in Toggl.
 */
export default function IndividualTimesheet({
  entries,
  nowMs,
  projectId,
  projectName,
}: TimesheetViewProps) {
  const week = useMemo(() => {
    if (!nowMs) return null;
    const weekStart = startOfWeekMonday(new Date(nowMs)).getTime();
    const weekEnd = weekStart + 7 * DAY_MS;

    const byDay: DayEntry[][] = Array.from({ length: 7 }, () => []);
    for (const e of entries) {
      if (e.project_id !== projectId) continue;
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
        tags: e.tags,
        desc: e.description ?? '',
      });
    }

    const days = byDay
      .map((dayEntries, dayIdx) => ({ dayIdx, dateMs: weekStart + dayIdx * DAY_MS, ...buildDay(dayEntries) }))
      .filter((d) => d.rows.length > 0 || d.overlaps.length > 0);

    const grandTotal = days.reduce((s, d) => s + d.total, 0);
    return { days, grandTotal };
  }, [entries, nowMs, projectId]);

  if (!week || week.days.length === 0) {
    return (
      <div className="center-msg" style={{ height: 'auto' }}>
        No entries on {projectName} this week yet.
      </div>
    );
  }

  return (
    <div className="ts-scroll ind-scroll">
      {week.days.map((day) => {
        const date = new Date(day.dateMs);
        const dateLabel = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return (
          <section key={day.dayIdx} className="ind-day">
            <div className="ind-day-head">
              <span className="ind-day-name">
                {DAY_LABELS[day.dayIdx]} · {dateLabel}
              </span>
              <span className="ind-day-total">{fmtHours(day.total)}</span>
            </div>
            <table className="ts-table ind-table">
              <thead>
                <tr>
                  <th className="ind-th-time">Time</th>
                  <th className="ind-th-hours">Hours</th>
                  <th className="ind-th-code">Billing</th>
                  <th className="ind-th-desc">Description</th>
                  <th className="ind-th-copy" aria-label="Copy" />
                </tr>
              </thead>
              <tbody>
                {day.rows.map((row) => {
                  const desc = row.descs.join('; ');
                  if (row.kind === 'warn') {
                    return (
                      <tr key={row.key} className="ts-row-warn">
                        <td className="ind-time ind-empty">—</td>
                        <td className="ind-hours">{fmtHours(row.rounded)}</td>
                        <td className="ind-code" colSpan={2}>
                          <span className="tag-warn amber" title="Fix this entry in Toggl">
                            ⚠ {WARN_LABEL[row.warn as WarnKind]}
                          </span>
                          {desc && <div className="ind-desc">{desc}</div>}
                        </td>
                        <td className="ind-copy">{desc && <CopyButton text={desc} />}</td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={row.key}>
                      <td className="ind-time">
                        {fmtTimeOfDay(row.startMs as number)}–{fmtTimeOfDay(row.endMs as number)}
                      </td>
                      <td className="ind-hours">{fmtHours(row.rounded)}</td>
                      <td className="ind-code">{row.code}</td>
                      <td className="ind-desc">{desc}</td>
                      <td className="ind-copy">{desc && <CopyButton text={desc} />}</td>
                    </tr>
                  );
                })}
                {day.overlaps.map((o) => (
                  <tr key={`o${o}`} className="ts-row-warn">
                    <td className="ind-time ind-empty">—</td>
                    <td className="ind-hours">—</td>
                    <td className="ind-code" colSpan={3}>
                      <span className="tag-warn amber" title="Two entries overlap — fix one in Toggl">
                        ⚠ Overlapping entries
                      </span>
                      <div className="ind-desc">{o}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
      <div className="ind-grand">
        Week total <strong>{fmtHours(week.grandTotal)}</strong>
      </div>
    </div>
  );
}
