'use client';

import { useMemo } from 'react';
import {
  billingTagsOf,
  fmtHours,
  roundQuartersPreservingTotal,
} from '@/lib/calc';
import type { TimesheetViewProps } from './types';
import CopyButton from './CopyButton';

// The week starts on Saturday, so the weekend leads the week (Sat/Sun, then Mon–Fri).
const DAY_LABELS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const DAY_MS = 24 * 3600 * 1000;
// Sentinel row keys for entries that need attention rather than a normal billing
// line. These stay global (not split per project) — a tagging problem is the same
// problem to fix in Toggl whichever project it's on.
const UNTAGGED = 'untagged'; // no billing tag at all
const MULTIPLE = 'multiple'; // more than one billing tag — ambiguous

interface Cell {
  descs: string[]; // de-duplicated, original-cased, in first-seen order
  seconds: number;
}

// A normal row is one (project, billing-tag) pair; warning rows are the sentinels.
interface RowMeta {
  projectId: number;
  projectName: string;
  tag: string;
}

/**
 * Summary view: the week as a grid of days (columns) × rows. A row is normally a
 * (project, billing-tag) pair — a project is a group of billing tags, so the same
 * tag under two projects stays on two separate rows, each prefixed by its project
 * name. With a single project selected the prefix is suppressed. Each day's
 * entries for a row are combined into one cell — durations summed, descriptions
 * merged without repeats — and rounded to 15-minute units so each day's cells
 * still add up to that day's rounded total (no accumulated drift).
 */
export default function SummaryTimesheet({
  entries,
  weekStart,
  nowMs,
  projects,
  multi,
  billingTagPrefix,
}: TimesheetViewProps) {
  const grid = useMemo(() => {
    if (!weekStart) return null;
    const ids = new Set(projects.map((p) => p.id));
    const nameById = new Map(projects.map((p) => [p.id, p.name]));
    const weekEnd = weekStart + 7 * DAY_MS;

    const cells = new Map<string, Cell>(); // key: `${dayIdx}|${rowKey}`
    const rowMeta = new Map<string, RowMeta>(); // rowKey -> meta (normal rows only)
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
      if (e.project_id == null || !ids.has(e.project_id)) continue;
      const startMs = new Date(e.start).getTime();
      if (!Number.isFinite(startMs) || startMs < weekStart || startMs >= weekEnd) continue;
      const dayIdx = Math.floor((startMs - weekStart) / DAY_MS);
      if (dayIdx < 0 || dayIdx > 6) continue;

      const running = e.duration < 0 || !e.stop;
      const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
      const seconds = Math.max(0, (stopMs - startMs) / 1000);

      // Which row this entry lands in: its (project, single billing tag), or a
      // warning row when it has none / more than one (both need fixing in Toggl).
      const tags = billingTagsOf(e.tags, billingTagPrefix);
      let rowKey: string;
      if (tags.length === 0) {
        rowKey = UNTAGGED;
        untaggedPresent = true;
      } else if (tags.length > 1) {
        rowKey = MULTIPLE;
        multiplePresent = true;
      } else {
        rowKey = `p${e.project_id}|${tags[0]}`;
        if (!rowMeta.has(rowKey)) {
          rowMeta.set(rowKey, {
            projectId: e.project_id,
            projectName: nameById.get(e.project_id) ?? '',
            tag: tags[0],
          });
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

    // Columns: Mon–Fri always; the leading Sat/Sun only when they have entries.
    // With a Saturday-start week those are indices 0–1, so weekdays are 2–6.
    const dayCols: number[] = [];
    for (let i = 0; i < 7; i++) {
      if (i >= 2 || dayHasEntries[i]) dayCols.push(i);
    }

    // Rows: normal rows grouped by project, then tag (both alphabetical), then the
    // warning rows (multiple, untagged) last.
    const tagRows = [...rowMeta.keys()].sort((a, b) => {
      const ma = rowMeta.get(a)!;
      const mb = rowMeta.get(b)!;
      return ma.projectName.localeCompare(mb.projectName) || ma.tag.localeCompare(mb.tag);
    });
    const rows = [...tagRows];
    if (multiplePresent) rows.push(MULTIPLE);
    if (untaggedPresent) rows.push(UNTAGGED);

    // Round to 15-minute units per day: each cell is rounded so the cells still add
    // up to the day's rounded total (no accumulated drift), with the rounding error
    // spread evenly across the rows. Totals are then summed from these rounded
    // cells, so every figure shown is a clean quarter-hour.
    const rounded = new Map<string, number>(); // key: `${dayIdx}|${rowKey}`
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

    return { dayCols, rows, rowMeta, cells, rounded, dayTotals, rowTotals, grandTotal };
  }, [entries, weekStart, nowMs, projects, billingTagPrefix]);

  if (!grid || grid.rows.length === 0) {
    return (
      <div className="center-msg" style={{ height: 'auto' }}>
        No entries for this week.
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
            const meta = grid.rowMeta.get(row);
            return (
              <tr key={row} className={warn ? 'ts-row-warn' : ''}>
                <th className="ts-tag" scope="row">
                  {warn ? (
                    <span className="tag-warn amber" title="Fix the billing tag in Toggl">
                      ⚠ {warn}
                    </span>
                  ) : (
                    <>
                      {multi && meta && <span className="ts-proj">{meta.projectName}: </span>}
                      {meta?.tag}
                    </>
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
