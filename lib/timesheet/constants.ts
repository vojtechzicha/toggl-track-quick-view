// Shared constants for the timesheet views and the exports built from them.
// Kept in one place so the on-screen views and the exporters agree exactly.

// The week starts on Saturday, so the weekend leads the week (Sat/Sun, then Mon–Fri).
export const DAY_LABELS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
export const DAY_MS = 24 * 3600 * 1000;

// Sentinel row keys for entries that need attention rather than a normal billing
// line. These stay global (not split per project) — a tagging problem is the same
// problem to fix in Toggl whichever project it's on.
export const UNTAGGED = 'untagged'; // no billing tag at all
export const MULTIPLE = 'multiple'; // more than one billing tag — ambiguous
export const TOOLONG = 'toolong'; // a single entry longer than the cap (individual view only)

/**
 * The billing line a project bills to when the workspace bills by project
 * rather than by billing code. Normally just the project's name — but a
 * selection's names are denormalised copies, and a project archived at the
 * source keeps whatever was stored, which for one selected before names were
 * captured is nothing at all. A blank billing line on a client's timesheet
 * would be a silent hole, so fall back to the id, which at least identifies it.
 * Shared so the Summary and Individual views can never disagree about it.
 */
export function projectBillingCode(name: string | undefined, projectId: number): string {
  return name?.trim() ? name : `#${projectId}`;
}
