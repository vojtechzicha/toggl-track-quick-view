// Billed time off, for both timesheet views and every export.
//
// A time-off entry (isTimeOffEntry in lib/calc) that also carries a billing tag
// ("D-HOL") still makes its day off on the dashboard: 0h target, and the weekly
// goal drops by a day. On the timesheet it bills as its own line instead of
// disappearing, and the day keeps its share of the week:
//
//   - The day is not a holiday for billing: the "Don't bill overtime" cap and
//     the balancing targets stay as for a working day.
//   - The time-off line is fixed, like a linked-code line: it counts toward the
//     cap and toward its day, but it is never trimmed, moved by balancing or
//     merged with work. It is rounded on its own and the billable-length cap
//     does not apply to it.
//
// So 32h of work plus an 8h billed holiday bills 40h on a 40h cap, where a
// second, separate "D-HOL 8h" entry would have been trimmed as overtime.
//
// Only an explicit billing tag turns it on; a support-ticket bracket in the
// description does not. It never applies with Bill by project or on a linked
// project: there the entry stays a plain, unbilled marker.

import { billingTagsOf, holidayDaysOfWeek, isTimeOffEntry, type TimeEntry } from '@/lib/calc';
import { mappingFor, type CodeMapping } from './mapping';

export interface TimeOffRules {
  timeOffTag?: string;
  billingTagPrefix: string;
  codeMappings?: CodeMapping[];
  billByProject?: boolean;
}

/** The billing tags on a time-off entry, the time-off tag itself excluded. */
export function timeOffBillingTags(tags: string[] | undefined, rules: TimeOffRules): string[] {
  return billingTagsOf(
    tags?.filter((t) => !isTimeOffEntry([t], rules.timeOffTag)),
    rules.billingTagPrefix
  );
}

/** True when a time-off entry also bills (see the top of this file). */
export function billsTimeOff(
  tags: string[] | undefined,
  projectId: number | null,
  rules: TimeOffRules
): boolean {
  if (rules.billByProject || !isTimeOffEntry(tags, rules.timeOffTag)) return false;
  if (mappingFor(rules.codeMappings, projectId)) return false;
  return timeOffBillingTags(tags, rules).length > 0;
}

/**
 * This week's holidays as the timesheet sees them. `holidays` is every day with
 * a time-off entry (holidayDaysOfWeek), which the views mark. `billing` leaves
 * out the days with billed time off, which keep their cap and balancing target.
 */
export function sheetHolidays(
  entries: TimeEntry[],
  projects: ReadonlySet<number>,
  weekStart: number,
  rules: TimeOffRules
): { holidays: Set<number>; billed: Set<number>; billing: Set<number> } {
  const holidays = holidayDaysOfWeek(entries, projects, weekStart, rules.timeOffTag);
  const billedEntries = entries.filter((e) => billsTimeOff(e.tags, e.project_id, rules));
  const billed = holidayDaysOfWeek(billedEntries, projects, weekStart, rules.timeOffTag);
  const billing = new Set([...holidays].filter((d) => !billed.has(d)));
  return { holidays, billed, billing };
}
