'use client';

import { useMemo } from 'react';
import {
  billingTagsOf,
  startOfWeekMonday,
  fmtHours,
  roundQuartersPreservingTotal,
} from '@/lib/calc';
import type { TimesheetViewProps } from './types';
import CopyButton from './CopyButton';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_MS = 24 * 3600 * 1000;
// Sentinel row keys for entries that need attention rather than a normal
// billing line.
const UNTAGGED = 'untagged'; // no billing tag at all
const MULTIPLE = 'multiple'; // more than one billing tag — ambiguous

interface Cell {
  descs: string[]; // de-duplicated, original-cased, in first-seen order
  seconds: number;
}

/**
 * Summary view: the week as a grid of days (columns) × billing tags (rows).
 * Each day's entries for a tag are combined into one cell — durations summed,
 * descriptions merged without repeats — and rounded to 15-minute units so each
 * day's cells still add up to that day's rounded total (no accumulated drift).
 */
export default function SummaryTimesheet({
  entries,
  nowMs,
  projectId,
  projectName,
}: TimesheetViewProps) {
  const grid = useMemo(() => {
    if (!nowMs) return null;
    const weekStart = startOfWeekMonday(new Date(nowMs)).getTime();
    const weekEnd = weekStart + 7 * DAY_MS;

    const cells = new Map<string, Cell>(); // key: `${dayIdx}|${tag}`
    const tagOrder: string[] = []; // billing tags in first-seen order
    const tagSeen = new Set<string>();
    const dayHasEntries = new Array(7).fill(false);
    let untaggedPresent = false;
    let multiplePresent = false;

    const addDesc = (cell: Cell, desc: string) => {
      const text = desc.trim();
      if (!text) return;
      if (cell.descs.some((d) => d.toLowerCase() === text.toLowerCase())) return;
      cell.descs.push(text);
    };

    for (const e of entries) {
      if (e.project_id !== projectId) continue;
      const startMs = new Date(e.start).getTime();
      if (!Number.isFinite(startMs) || startMs < weekStart || startMs >= weekEnd) continue;
      const dayIdx = Math.floor((startMs - weekStart) / DAY_MS);
      if (dayIdx < 0 || dayIdx > 6) continue;

      const running = e.duration < 0 || !e.stop;
      const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
      const seconds = Math.max(0, (stopMs - startMs) / 1000);

      // Which row this entry lands in: its single billing tag, or a warning row
      // when it has none / more than one (both need fixing in Toggl).
      const tags = billingTagsOf(e.tags);
      let rowKey: string;
      if (tags.length === 0) {
        rowKey = UNTAGGED;
        untaggedPresent = true;
      } else if (tags.length > 1) {
        rowKey = MULTIPLE;
        multiplePresent = true;
      } else {
        rowKey = tags[0];
        if (!tagSeen.has(rowKey)) {
          tagSeen.add(rowKey);
          tagOrder.push(rowKey);
        }
      }
      dayHasEntries[dayIdx] = true;

      const key = `${dayIdx}|${rowKey}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { descs: [], seconds: 0 };
        cells.set(key, cell);
      }
      cell.seconds += seconds;
      addDesc(cell, e.description ?? '');
    }

    // Columns: Mon–Fri always; Sat/Sun only when they actually have entries.
    const dayCols: number[] = [];
    for (let i = 0; i < 7; i++) {
      if (i < 5 || dayHasEntries[i]) dayCols.push(i);
    }

    // Rows: billing tags (sorted), then the warning rows (multiple, untagged) last.
    const tagRows = [...tagOrder].sort((a, b) => a.localeCompare(b));
    const rows = [...tagRows];
    if (multiplePresent) rows.push(MULTIPLE);
    if (untaggedPresent) rows.push(UNTAGGED);

    // Round to 15-minute units per day: each billing-tag cell is rounded so the
    // cells still add up to the day's rounded total (no accumulated drift), with
    // the rounding error spread evenly across the tags. Totals are then summed
    // from these rounded cells, so every figure shown is a clean quarter-hour.
    const rounded = new Map<string, number>(); // key: `${dayIdx}|${tag}`
    for (const d of dayCols) {
      const raw = rows.map((r) => cells.get(`${d}|${r}`)?.seconds ?? 0);
      const adj = roundQuartersPreservingTotal(raw);
      rows.forEach((r, ri) => rounded.set(`${d}|${r}`, adj[ri]));
    }

    const dayTotals = dayCols.map((d) =>
      rows.reduce((s, r) => s + (rounded.get(`${d}|${r}`) ?? 0), 0)
    );
    const rowTotals = rows.map((r) =>
      dayCols.reduce((s, d) => s + (rounded.get(`${d}|${r}`) ?? 0), 0)
    );
    const grandTotal = rowTotals.reduce((s, v) => s + v, 0);

    return { weekStart, dayCols, rows, cells, rounded, dayTotals, rowTotals, grandTotal };
  }, [entries, nowMs, projectId]);

  if (!grid || grid.rows.length === 0) {
    return (
      <div className="center-msg" style={{ height: 'auto' }}>
        No entries on {projectName} this week yet.
      </div>
    );
  }

  return (
    <div className="ts-scroll">
      <table className="ts-table">
        <thead>
          <tr>
            <th className="ts-corner">Billing tag</th>
            {grid.dayCols.map((d) => (
              <th key={d} className="ts-day-head">
                {DAY_LABELS[d]}
              </th>
            ))}
            <th className="ts-total-head">Total</th>
          </tr>
        </thead>
        <tbody>
          {grid.rows.map((row, ri) => {
            const warn =
              row === UNTAGGED
                ? 'No billing tag'
                : row === MULTIPLE
                ? 'Multiple billing tags'
                : null;
            return (
              <tr key={row} className={warn ? 'ts-row-warn' : ''}>
                <th className="ts-tag" scope="row">
                  {warn ? (
                    <span className="tag-warn amber" title="Fix the billing tag in Toggl">
                      ⚠ {warn}
                    </span>
                  ) : (
                    row
                  )}
                </th>
                {grid.dayCols.map((d) => {
                  const secs = grid.rounded.get(`${d}|${row}`) ?? 0;
                  if (secs === 0) {
                    return (
                      <td key={d} className="ts-cell ts-empty">
                        —
                      </td>
                    );
                  }
                  const combined = (grid.cells.get(`${d}|${row}`)?.descs ?? []).join('; ');
                  return (
                    <td key={d} className="ts-cell">
                      <div className="ts-cell-head">
                        <span className="ts-dur">{fmtHours(secs)}</span>
                        {combined && <CopyButton text={combined} />}
                      </div>
                      {combined && <div className="ts-desc">{combined}</div>}
                    </td>
                  );
                })}
                <td className="ts-cell ts-rowtotal">{fmtHours(grid.rowTotals[ri])}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <th className="ts-tag">Total</th>
            {grid.dayTotals.map((sec, i) => (
              <td key={grid.dayCols[i]} className="ts-cell ts-coltotal">
                {sec > 0 ? fmtHours(sec) : '—'}
              </td>
            ))}
            <td className="ts-cell ts-grandtotal">{fmtHours(grid.grandTotal)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
