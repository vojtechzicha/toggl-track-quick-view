// Local time for the MCP tools. The dashboard computes in the browser's zone;
// on the server the timesheet builders (lib/timesheet) use the process's local
// zone, so the MCP route sets process.env.TZ to APP_TIME_ZONE before anything
// else runs (useAppTimeZone). Node re-reads TZ when it is assigned.

import { addDays, startOfDay, startOfWeek } from '@/lib/calc';

export const DEFAULT_TIME_ZONE = 'Europe/Prague';

export function appTimeZone(): string {
  return process.env.APP_TIME_ZONE?.trim() || DEFAULT_TIME_ZONE;
}

/** Make the process's local zone the app's. Idempotent. */
export function useAppTimeZone(): string {
  const zone = appTimeZone();
  if (process.env.TZ !== zone) process.env.TZ = zone;
  return zone;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "YYYY-MM-DD" → local midnight (ms), or null. */
export function parseDate(s: string): number | null {
  const m = DATE_RE.exec(s.trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) {
    return null;
  }
  return d.getTime();
}

const ISO_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/** Calendar and clock parts that exist (no month 13, February 30 or 24:00). */
function validParts(y: number, mo: number, d: number, h: number, mi: number, se: number): boolean {
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
  return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

/**
 * A point in time: local wall time ("2026-10-30T09:15", "2026-10-30 09:15")
 * in the app's zone, or an ISO string with an offset or Z. Null if
 * unparseable or not a real date and time (no rolling over into another day).
 */
export function parseInstant(s: string): number | null {
  const v = s.trim();
  const m = LOCAL_RE.exec(v);
  if (m) {
    const [y, mo, d, h, mi, se] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
    if (!validParts(y, mo, d, h, mi, se)) return null;
    const date = new Date(y, mo - 1, d, h, mi, se);
    // Reject wall times skipped by a DST jump (the Date rolls them forward).
    if (date.getDate() !== d || date.getHours() !== h || date.getMinutes() !== mi) return null;
    return date.getTime();
  }
  const o = ISO_OFFSET_RE.exec(v);
  if (o) {
    const [y, mo, d, h, mi, se] = [o[1], o[2], o[3], o[4], o[5], o[6] ?? '0'].map(Number);
    if (!validParts(y, mo, d, h, mi, se)) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "YYYY-MM-DD" in the local zone. */
export function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "HH:MM" in the local zone. */
export function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "YYYY-MM-DDTHH:MM" in the local zone. */
export function fmtLocal(ms: number): string {
  return `${fmtDate(ms)}T${fmtClock(ms)}`;
}

/** Decimal hours, 2 dp. */
export function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

/**
 * An inclusive local date range → [fromMs, toMs) (local midnights). Throws a
 * plain Error with a usable message.
 */
export function dateRange(from: string, to: string): { fromMs: number; toMs: number } {
  const a = parseDate(from);
  const b = parseDate(to);
  if (a === null) throw new Error(`"${from}" is not a date (YYYY-MM-DD).`);
  if (b === null) throw new Error(`"${to}" is not a date (YYYY-MM-DD).`);
  if (b < a) throw new Error('"to" is before "from".');
  return { fromMs: a, toMs: addDays(b, 1) };
}

/** The Saturday that starts the week containing `ms` (local midnight). */
export function weekStartOf(ms: number): number {
  return startOfWeek(new Date(ms)).getTime();
}

export { addDays, startOfDay };
