'use client';

import { useMemo } from 'react';
import { fmtHours, fmtTimeOfDay } from '@/lib/calc';
import { buildIndividualWeek, warnLabel, type WarnKind } from '@/lib/timesheet/individual';
import { DAY_LABELS } from '@/lib/timesheet/constants';
import type { TimesheetViewProps } from './types';
import CopyButton from './CopyButton';

/**
 * Individual view: per day, one row per billable line with start–end time,
 * rounded hours and description, plus warning rows for tag, length and overlap
 * problems. Built by buildIndividualWeek, which the exports also use.
 */
export default function IndividualTimesheet({
  entries,
  weekStart,
  nowMs,
  projects,
  multi,
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
}: TimesheetViewProps) {
  const week = useMemo(
    () =>
      buildIndividualWeek({
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
      }),
    [
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
    ]
  );

  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  if (!week || week.days.length === 0) {
    return (
      <div className="center-msg" style={{ height: 'auto' }}>
        No entries for this week.
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
                {day.holiday && (
                  <span
                    className="ts-holiday"
                    title="Time off: no work expected. The weekly cap is one day lower."
                  >
                    holiday
                  </span>
                )}
              </span>
              <span className="ind-day-total">{fmtHours(day.total)}</span>
            </div>
            <table className="ts-table ind-table">
              <thead>
                <tr>
                  <th className="ind-th-time">Time</th>
                  <th className="ind-th-hours">Hours</th>
                  <th className="ind-th-code">{billByProject ? 'Project' : 'Billing'}</th>
                  <th className="ind-th-desc">Description</th>
                  <th className="ind-th-copy" aria-label="Copy" />
                </tr>
              </thead>
              <tbody>
                {day.rows.map((row) => {
                  const desc = row.desc;
                  if (row.kind === 'warn') {
                    return (
                      <tr key={row.key} className="ts-row-warn">
                        <td className="ind-time ind-empty">—</td>
                        <td className="ind-hours">{fmtHours(row.rounded)}</td>
                        <td className="ind-code" colSpan={2}>
                          <span className="tag-warn amber" title="Fix these entries">
                            ⚠ {warnLabel(row.warn as WarnKind, maxBillableHours)}
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
                      <td className="ind-code">
                        {/* No prefix when billing by project: the code is the project. */}
                        {multi && !billByProject && row.projId != null && (
                          <span className="ts-proj">{nameById.get(row.projId) ?? ''}: </span>
                        )}
                        {row.code}
                      </td>
                      <td className="ind-desc">
                        {row.descTruncated && (
                          <span
                            className="ts-desc-cut"
                            title={`Shortened to the ${maxDescriptionLength}-character limit. Full description: ${row.descs.join('; ')}`}
                          >
                            ✂{' '}
                          </span>
                        )}
                        {desc}
                      </td>
                      <td className="ind-copy">{desc && <CopyButton text={desc} />}</td>
                    </tr>
                  );
                })}
                {day.overlaps.map((o) => (
                  <tr key={`o${o}`} className="ts-row-warn">
                    <td className="ind-time ind-empty">—</td>
                    <td className="ind-hours">—</td>
                    <td className="ind-code" colSpan={3}>
                      <span className="tag-warn amber" title="Two entries overlap. Fix one of them.">
                        ⚠ Overlapping entries
                      </span>
                      <div className="ind-desc">{o}</div>
                    </td>
                  </tr>
                ))}
                {day.overtime > 0 && (
                  <tr className="ts-row-overtime">
                    <td className="ind-time ind-empty">—</td>
                    <td className="ind-hours">−{fmtHours(day.overtime)}</td>
                    <td className="ind-code" colSpan={3}>
                      <span className="ts-overtime" title="Tracked but not billed: over the weekly cap">
                        Overtime (not billed)
                      </span>
                    </td>
                  </tr>
                )}
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
