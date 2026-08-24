import type { TimeEntry } from '@/lib/calc';
import type { SelectedProject } from '@/components/SettingsPanel';
import type { CodeMapping } from '@/lib/timesheet/mapping';

/**
 * Props every timesheet view receives. The page owns the single source poll (via
 * useTrackSource) and hands each view the same week's data; a view is only ever mounted
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
  // The grid the Individual view anchors a line's start time to, in seconds —
  // already resolved: the rounding unit unless the workspace anchors starts to a
  // coarser window (see lib/calc startWindowUnitSeconds). The Summary view shows
  // no times, so it ignores this.
  startWindowSeconds: number;
  // Optional cap (characters) on every merged description the timesheet shows,
  // copies or exports — the client's system rejects longer messages. null = off.
  maxDescriptionLength: number | null;
  // When true, the week's billable total is capped at `weeklyHours` (overtime
  // isn't billable): billable lines are trimmed down and the stripped time shown
  // on a separate "Overtime" line. Trimmable "(X)"-marked codes go first.
  noOvertime: boolean;
  // The weekly cap (hours) overtime trimming reduces the billed total to.
  weeklyHours: number;
  // The tag marking a time-off entry (state holiday etc.): its day becomes a
  // non-working day — 0h expected, the weekly cap drops by a day's worth — and
  // the marker entry itself is never billed or shown.
  timeOffTag: string;
  // Linked billing codes: projects billed here as one fixed code per day, rounded
  // on their own grid (see lib/timesheet/mapping).
  codeMappings: CodeMapping[];
  // When true, billing codes show without their parenthetical groups (the
  // "(X)"/"(!)" markers are interpreted first, then the strip runs).
  stripCodeParens: boolean;
  // When true, the workspace doesn't use billing codes at all: entries bill to
  // their project, which is what the views show in the billing column. No entry
  // can then be untagged or multi-tagged, so those warnings never appear.
  billByProject: boolean;
}
