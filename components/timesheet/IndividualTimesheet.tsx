'use client';

/**
 * Individual view: will list each time entry on its own row (not yet grouped or
 * combined). Placeholder for now — see SummaryTimesheet for the implemented view.
 * Takes no props yet; it's still assignable to the shared view type.
 */
export default function IndividualTimesheet() {
  return (
    <div className="center-msg" style={{ height: 'auto' }}>
      The individual timesheet is coming soon. Switch to the summary view in settings to see this
      week grouped by billing tag.
    </div>
  );
}
