// Small shared helpers for the tracker UI (standalone mode).

import { billingTagOf, type TimeEntry } from '@/lib/calc';
import type { StoreWorkspace } from '@/lib/source/standalone';

/** ms → the local "YYYY-MM-DDTHH:mm" string a datetime-local input wants. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** datetime-local string → ms (local time), or null when unparseable/empty. */
export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Replace an entry's billing tag (the first tag matching the workspace's
 * prefix) with `tag`, keeping every other tag untouched. `tag: null` removes
 * it. The tracker edits exactly one billing tag per entry — that's the only
 * tag anything downstream reads.
 */
export function withBillingTag(
  tags: string[] | undefined,
  prefix: string,
  tag: string | null
): string[] {
  const current = billingTagOf(tags, prefix);
  const rest = (tags ?? []).filter((t) => t !== current);
  return tag ? [tag, ...rest] : rest;
}

/** The workspace's billing-tag prefix (falls back to the app default "D"). */
export function prefixFor(workspaces: StoreWorkspace[], workspaceId: number | null): string {
  const ws = workspaces.find((w) => w.id === workspaceId);
  return ws?.settings.billingTagPrefix || 'D';
}

export function isRunning(e: TimeEntry): boolean {
  return e.duration < 0 || !e.stop;
}

/** Entry duration in seconds; a running entry counts live up to `nowMs`. */
export function durationSec(e: TimeEntry, nowMs: number): number {
  if (isRunning(e)) return Math.max(0, (nowMs - Date.parse(e.start)) / 1000);
  return Math.max(0, e.duration);
}
