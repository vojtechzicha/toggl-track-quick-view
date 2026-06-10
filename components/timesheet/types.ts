import type { TimeEntry } from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';

/**
 * Props every timesheet view receives. The page owns the single Toggl poll (via
 * useToggl) and hands each view the same week's data; a view is only ever mounted
 * once at least one project is selected, so `projects` is non-empty.
 *
 * A project is a group of billing tags: entries are kept separate per project even
 * when they share a billing tag, and the project name prefixes the tag. When only
 * one project is selected (`multi` is false) the prefix is suppressed so the view
 * looks exactly as it did before multi-project support.
 */
export interface TimesheetViewProps {
  entries: TimeEntry[];
  // Saturday 00:00 (local, ms) of the week being shown. Explicit rather than
  // derived from `nowMs` so the same view renders any week — the current one
  // (live) or a selected past one.
  weekStart: number;
  // Real wall-clock now (ms), used only to clamp a still-running entry's stop.
  // A past week has none, so it has no effect there.
  nowMs: number;
  projects: SelectedProject[];
  // True when more than one project is selected → show the project-name prefix.
  multi: boolean;
  // The resolved per-line billable cap in hours (override or proportional default).
  maxBillableHours: number;
  // The prefix that marks a Toggl tag as a billing tag (default "D").
  billingTagPrefix: string;
  // The rounding granularity in seconds (900 = 15 min default, 720 = 12 min).
  roundingSeconds: number;
}
