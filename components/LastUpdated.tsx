'use client';

import { fmtTimeOfDay } from '@/lib/calc';

/**
 * Footer note with the time the source produced the shown data, so a stale page
 * is recognizable. With Toggl this is the upstream fetch time, even when the
 * server cache answered. Marked stale (amber) once older than two refresh
 * intervals. Hidden until the first successful fetch.
 */
export default function LastUpdated({
  lastUpdatedMs,
  nowMs,
  refreshSec,
}: {
  lastUpdatedMs: number;
  nowMs: number;
  /** Expected refresh interval; null = manual refresh, never stale. */
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
