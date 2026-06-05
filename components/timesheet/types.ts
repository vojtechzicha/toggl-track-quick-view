import type { TimeEntry } from '@/lib/calc';

/**
 * Props every timesheet view receives. The page owns the single Toggl poll (via
 * useToggl) and hands each view the same week's data; a view is only ever
 * mounted once a project is selected, so `projectId` is non-null.
 */
export interface TimesheetViewProps {
  entries: TimeEntry[];
  nowMs: number;
  projectId: number;
  projectName: string;
  // The resolved per-line billable cap in hours (override or proportional default).
  maxBillableHours: number;
}
