import type { TimeEntry } from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import type { CodeMapping } from '@/lib/timesheet/mapping';

/**
 * Props for both timesheet views. The page polls the data source (useTrackSource)
 * and passes each view the same week. Views mount only when a project is
 * selected, so `projects` is non-empty.
 *
 * Entries stay separate per project even when they share a billing code, and
 * the project name prefixes the code when more than one project is selected.
 */
export interface TimesheetViewProps {
  entries: TimeEntry[];
  // Saturday 00:00 (local, ms) of the week shown, current or past.
  weekStart: number;
  // Current time (ms). Used only as the stop of a running entry.
  nowMs: number;
  projects: SelectedProject[];
  // More than one project selected: prefix codes with the project name.
  multi: boolean;
  // Per-line billable cap in hours, already resolved.
  maxBillableHours: number;
  // Billing-tag prefix (default "D").
  billingTagPrefix: string;
  // Rounding unit in seconds (900 = 15 min, 720 = 12 min).
  roundingSeconds: number;
  // Start-time grid in seconds, already resolved (see startWindowUnitSeconds in
  // lib/calc). Only the Individual view uses it.
  startWindowSeconds: number;
  // Character limit for descriptions shown, copied and exported. null = none.
  maxDescriptionLength: number | null;
  // Cap the billed total at `weeklyHours` and show trimmed time on an
  // "Overtime" line (see lib/timesheet/overtime).
  noOvertime: boolean;
  weeklyHours: number;
  // Tag marking a time-off entry (see isTimeOffEntry in lib/calc).
  timeOffTag: string;
  // Projects billed as one fixed code per day (see lib/timesheet/mapping).
  codeMappings: CodeMapping[];
  // Show codes without their parenthetical groups.
  stripCodeParens: boolean;
  // Bill entries to their project instead of a billing code. The untagged and
  // multi-tagged warnings then never appear.
  billByProject: boolean;
}
