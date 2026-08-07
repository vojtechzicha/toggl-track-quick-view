'use client';

import { fmtTimeOfDay } from '@/lib/calc';

/**
 * Footer note showing when the on-screen data was last fetched, so a viewer can
 * tell they're looking at a stale page (tab left open overnight, laptop asleep,
 * source unreachable). Turns amber once the data is older than two refresh
 * intervals — anything younger is just normal polling cadence, not staleness.
 * Hidden until the first successful fetch.
 */
export default function LastUpdated({
  lastUpdatedMs,
  nowMs,
  refreshSec,
}: {
  lastUpdatedMs: number;
  nowMs: number;
  /** Expected refresh cadence; null = manual refresh (never marked stale). */
  refreshSec: number | null;
}) {
  if (!lastUpdatedMs || !nowMs) return null;
  const stale = refreshSec !== null && nowMs - lastUpdatedMs > 2 * refreshSec * 1000;
  const sameDay = new Date(lastUpdatedMs).toDateString() === new Date(nowMs).toDateString();
  const when = sameDay
    ? fmtTimeOfDay(lastUpdatedMs)
    : `${new Date(lastUpdatedMs).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      })} ${fmtTimeOfDay(lastUpdatedMs)}`;
  return (
    <span
      className={stale ? 'updated stale' : 'updated'}
      title={new Date(lastUpdatedMs).toLocaleString()}
    >
      {' · '}updated {when}
    </span>
  );
}
