'use client';

import { useMemo } from 'react';
import { fmtHours } from '@/lib/calc';
import { buildSummaryGrid } from '@/lib/timesheet/summary';
import { DAY_LABELS, UNTAGGED, MULTIPLE } from '@/lib/timesheet/constants';
import type { TimesheetViewProps } from './types';
import CopyButton from './CopyButton';

/**
 * Summary view: the week as a grid of days (columns) × rows. A row is normally a
 * (project, billing-tag) pair — a project is a group of billing tags, so the same
 * tag under two projects stays on two separate rows, each prefixed by its project
 * name. With a single project selected the prefix is suppressed. Each day's
 * entries for a row are combined into one cell — durations summed, descriptions
 * merged without repeats — and rounded to the configured unit so each day's cells
 * still add up to that day's rounded total (no accumulated drift).
 *
 * The grid is built by the shared `buildSummaryGrid` so exports match exactly.
 */
export default function SummaryTimesheet({
  entries,
  weekStart,
  nowMs,
  projects,
  multi,
  billingTagPrefix,
  roundingSeconds,
  noOvertime,
  weeklyHours,
  codeMappings,
}: TimesheetViewProps) {
  const grid = useMemo(
    () =>
      buildSummaryGrid({
        entries,
        weekStart,
        nowMs,
        projects,
        billingTagPrefix,
        roundingSeconds,
        noOvertime,
        weeklyHours,
        codeMappings,
      }),
    [entries, weekStart, nowMs, projects, billingTagPrefix, roundingSeconds, noOvertime, weeklyHours, codeMappings]
  );

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
            // A billable row trimmed to nothing for the whole week (e.g. an "(X)"
            // buffer fully consumed by the overtime cap) is dropped, matching the
            // export. Warning rows always stay so the problem keeps surfacing.
            if (!warn && grid.rowTotals[ri] === 0) return null;
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
          {grid.overtimeTotal > 0 && (
            <tr className="ts-row-overtime">
              <th className="ts-tag" scope="row">
                <span className="ts-overtime" title="Tracked but not billed — over the weekly cap">
                  Overtime (not billed)
                </span>
              </th>
              {grid.dayCols.map((d) => {
                const secs = grid.overtimeByDay[d] ?? 0;
                return (
                  <td key={d} className="ts-cell ts-overtime-cell">
                    {secs > 0 ? `−${fmtHours(secs)}` : '—'}
                  </td>
                );
              })}
              <td className="ts-cell ts-overtime-cell">−{fmtHours(grid.overtimeTotal)}</td>
            </tr>
          )}
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
