'use client';

import { useMemo } from 'react';
import { fmtHM, fmtHours } from '@/lib/calc';
import { buildSummaryGrid } from '@/lib/timesheet/summary';
import { DAY_LABELS, UNTAGGED, MULTIPLE, warnDisplaySeconds } from '@/lib/timesheet/constants';
import type { TimesheetViewProps } from './types';
import CopyButton from './CopyButton';

const HOLIDAY_TITLE = 'Time off: no work expected. The weekly cap is one day lower.';
const HOLIDAY_BILLED_TITLE =
  'Billed time off: no work expected. The time-off line bills, so the weekly cap stays whole.';
const UNROUNDED_TITLE = 'Not billed, so shown unrounded.';

/**
 * Summary view: the week as days (columns) × (project, billing code) rows, one
 * merged and rounded cell per row and day. Built by buildSummaryGrid, which the
 * exports also use.
 */
export default function SummaryTimesheet({
  entries,
  weekStart,
  nowMs,
  projects,
  multi,
  billingTagPrefix,
  roundingSeconds,
  maxDescriptionLength,
  noOvertime,
  weeklyHours,
  balanceWeekdays,
  timeOffTag,
  codeMappings,
  stripCodeParens,
  billByProject,
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
        maxDescriptionLength,
        noOvertime,
        weeklyHours,
        balanceWeekdays,
        timeOffTag,
        codeMappings,
        stripCodeParens,
        billByProject,
      }),
    [entries, weekStart, nowMs, projects, billingTagPrefix, roundingSeconds, maxDescriptionLength, noOvertime, weeklyHours, balanceWeekdays, timeOffTag, codeMappings, stripCodeParens, billByProject]
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
            <th className="ts-corner">{billByProject ? 'Project' : 'Billing tag'}</th>
            {grid.dayCols.map((d) => (
              <th key={d} className="ts-day-head">
                {DAY_LABELS[d]}
                {grid.holidays.has(d) && (
                  <span
                    className="ts-holiday"
                    title={grid.billedHolidays.has(d) ? HOLIDAY_BILLED_TITLE : HOLIDAY_TITLE}
                  >
                    holiday
                  </span>
                )}
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
            // Hide billable rows trimmed to zero for the week, as the export does.
            // Warning rows always show.
            if (!warn && grid.rowTotals[ri] === 0) return null;
            const meta = grid.rowMeta.get(row);
            // Warning rows are not billed, so they show unrounded time (to the
            // minute), and their total is the sum of the cells as shown.
            const warnSecs = (d: number) => warnDisplaySeconds(grid.cells.get(`${d}|${row}`)?.seconds ?? 0);
            return (
              <tr key={row} className={warn ? 'ts-row-warn' : ''}>
                <th className="ts-tag" scope="row">
                  {warn ? (
                    <span className="tag-warn amber" title="Fix the billing tags on these entries">
                      ⚠ {warn}
                    </span>
                  ) : (
                    <>
                      {/* No prefix when billing by project: the row is the project. */}
                      {multi && !billByProject && meta && (
                        <span className="ts-proj">{meta.projectName}: </span>
                      )}
                      {meta?.tag}
                    </>
                  )}
                </th>
                {grid.dayCols.map((d) => {
                  const secs = warn ? warnSecs(d) : grid.rounded.get(`${d}|${row}`) ?? 0;
                  const cell = grid.cells.get(`${d}|${row}`);
                  if (secs === 0) {
                    return (
                      <td key={d} className="ts-cell ts-empty">
                        —
                      </td>
                    );
                  }
                  const combined = cell?.desc ?? '';
                  return (
                    <td key={d} className="ts-cell">
                      <div className="ts-cell-head">
                        {warn ? (
                          <span className="ts-dur" title={UNROUNDED_TITLE}>
                            {fmtHM(secs)}
                          </span>
                        ) : (
                          <span className="ts-dur">{fmtHours(secs)}</span>
                        )}
                        {combined && <CopyButton text={combined} />}
                      </div>
                      {combined && (
                        <div className="ts-desc">
                          {cell?.descTruncated && (
                            <span
                              className="ts-desc-cut"
                              title={`Shortened to the ${maxDescriptionLength}-character limit. Full description: ${cell.descs.join('; ')}`}
                            >
                              ✂{' '}
                            </span>
                          )}
                          {combined}
                        </div>
                      )}
                    </td>
                  );
                })}
                <td className="ts-cell ts-rowtotal">
                  {warn ? (
                    <span title={UNROUNDED_TITLE}>
                      {fmtHM(grid.dayCols.reduce((s, d) => s + warnSecs(d), 0))}
                    </span>
                  ) : (
                    fmtHours(grid.rowTotals[ri])
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          {grid.overtimeTotal > 0 && (
            <tr className="ts-row-overtime">
              <th className="ts-tag" scope="row">
                <span className="ts-overtime" title="Tracked but not billed: over the weekly cap">
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
          {grid.balancedByDay.some((v) => v !== 0) && (
            <tr className="ts-row-overtime">
              <th className="ts-tag" scope="row">
                <span
                  className="ts-overtime"
                  title="Billed time moved between working days so each reaches the daily target. Already in the rows above."
                >
                  Balanced
                </span>
              </th>
              {grid.dayCols.map((d) => {
                const secs = grid.balancedByDay[d] ?? 0;
                return (
                  <td key={d} className="ts-cell ts-overtime-cell">
                    {secs > 0 ? `+${fmtHours(secs)}` : secs < 0 ? `−${fmtHours(-secs)}` : '—'}
                  </td>
                );
              })}
              <td className="ts-cell ts-overtime-cell">—</td>
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
