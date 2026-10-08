// Constants shared by the timesheet views and the exports.

// Weeks start on Saturday.
export const DAY_LABELS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
export const DAY_MS = 24 * 3600 * 1000;

// Row keys for entries that need fixing instead of a billing line. They are not
// split per project.
export const UNTAGGED = 'untagged'; // no billing tag
export const MULTIPLE = 'multiple'; // more than one billing tag
export const TOOLONG = 'toolong'; // one entry longer than the cap (Individual view only)

/**
 * A warning row's time as the views show it. Warning rows are not billed, so it
 * is not rounded to the unit, only to the minute, and never below one minute so
 * a few stray seconds still show. A row total sums these, so it equals its
 * cells as shown.
 */
export function warnDisplaySeconds(seconds: number): number {
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) * 60 : 0;
}

/**
 * The billing line for a project when the workspace bills by project: its
 * name, or `#id` when the stored name is empty (possible for an archived
 * project), so the timesheet never has a blank line.
 */
export function projectBillingCode(name: string | undefined, projectId: number): string {
  return name?.trim() ? name : `#${projectId}`;
}
