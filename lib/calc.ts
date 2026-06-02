// Pure calculation helpers for the quick view. Kept free of React / DOM so the
// logic is easy to reason about (and unit-test) in isolation.

export const STANDARD_DAY_HOURS = 8; // plain target when "short Friday" is off
export const WEEKLY_HOURS = 40; // weekly goal used by the short-Friday model
export const MIDWEEK_TARGET_HOURS = 9; // Mon/Tue/Wed target with short Friday on
export const DESIRED_FRIDAY_HOURS = 5; // amount Thursday tries to leave for Friday
export const BREAK_AFTER_HOURS = 4.5; // remind to take a break after this much
export const BREAK_GAP_MINUTES = 10; // a gap >= this counts as a real break
export const MAX_DAILY_TARGET_HOURS = 12; // clamp so a bad week can't demand 16h
export const UNREPORTED_MIN_MINUTES = 1; // ignore gaps shorter than this as noise

const HOUR = 3600;
const MS = 1000;

/** Raw shape of a Toggl time entry (only the fields we use). */
export interface TimeEntry {
  id: number;
  start: string;
  stop: string | null;
  duration: number; // seconds; negative (= -unixStart) while running
  project_id: number | null;
  workspace_id: number;
  description?: string;
}

/** Normalised entry with absolute millisecond bounds (running => stop is "now"). */
export interface NormEntry {
  id: number;
  startMs: number;
  stopMs: number;
  projectId: number | null;
  running: boolean;
}

export function normalize(entries: TimeEntry[], nowMs: number): NormEntry[] {
  return entries
    .map((e) => {
      const startMs = new Date(e.start).getTime();
      const running = e.duration < 0 || !e.stop;
      const stopMs = running ? nowMs : new Date(e.stop as string).getTime();
      return { id: e.id, startMs, stopMs, projectId: e.project_id, running };
    })
    .filter((e) => Number.isFinite(e.startMs))
    .sort((a, b) => a.startMs - b.startMs);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** Monday 00:00 (local) of the week containing `d`. */
export function startOfWeekMonday(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 Sun .. 6 Sat
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return x;
}

/**
 * Seconds spent on `projectId` that overlap [fromMs, toMs). Overlap-based so a
 * running entry contributes live time as `toMs` (now) advances.
 */
export function projectSecondsInRange(
  entries: NormEntry[],
  projectId: number,
  fromMs: number,
  toMs: number
): number {
  let total = 0;
  for (const e of entries) {
    if (e.projectId !== projectId) continue;
    const a = Math.max(e.startMs, fromMs);
    const b = Math.min(e.stopMs, toMs);
    if (b > a) total += (b - a) / MS;
  }
  return total;
}

/**
 * Today's target in seconds.
 *
 * Without short Friday: a flat 8h every day.
 *
 * With short Friday (weekly goal 40h):
 *   - Mon/Tue/Wed: 9h each.
 *   - Thursday: recalculated to leave ~5h for Friday, i.e.
 *       40h - (project hours already logged Mon–Wed) - 5h.
 *   - Friday: simply whatever remains to reach 40h for the week.
 *   - Weekend: falls back to 8h.
 * Thursday/Friday are clamped to [0, 12h] so an unusual week stays sane.
 */
export function dailyTargetSeconds(
  now: Date,
  entries: NormEntry[],
  projectId: number,
  shortFriday: boolean
): number {
  if (!shortFriday) return STANDARD_DAY_HOURS * HOUR;

  const day = now.getDay();
  if (day === 1 || day === 2 || day === 3) return MIDWEEK_TARGET_HOURS * HOUR;

  const weekStart = startOfWeekMonday(now).getTime();
  const todayStart = startOfDay(now).getTime();
  const max = MAX_DAILY_TARGET_HOURS * HOUR;

  if (day === 4) {
    const loggedThroughWed = projectSecondsInRange(entries, projectId, weekStart, todayStart);
    const target = WEEKLY_HOURS * HOUR - loggedThroughWed - DESIRED_FRIDAY_HOURS * HOUR;
    return clamp(target, 0, max);
  }

  if (day === 5) {
    const loggedThroughThu = projectSecondsInRange(entries, projectId, weekStart, todayStart);
    const target = WEEKLY_HOURS * HOUR - loggedThroughThu;
    return clamp(target, 0, max);
  }

  return STANDARD_DAY_HOURS * HOUR; // weekend
}

/**
 * How long you've been continuously working on `projectId` right now.
 *
 * Returns `working: false` unless an entry for this project is currently
 * running. The continuous streak walks backwards from the running entry and
 * ends (i.e. a break is detected) at the first of:
 *   - a gap of >= BREAK_GAP_MINUTES between consecutive entries, or
 *   - an entry on a different project (a context switch counts as a break).
 */
export function continuousWorkSeconds(
  entries: NormEntry[],
  projectId: number,
  nowMs: number
): { working: boolean; seconds: number } {
  const runningIdx = entries.findIndex((e) => e.running && e.projectId === projectId);
  if (runningIdx === -1) return { working: false, seconds: 0 };

  const gapMs = BREAK_GAP_MINUTES * 60 * MS;
  let streakStart = entries[runningIdx].startMs;

  for (let i = runningIdx - 1; i >= 0; i--) {
    const prev = entries[i];
    const next = entries[i + 1];
    if (prev.projectId !== projectId) break; // worked elsewhere => break taken
    if (next.startMs - prev.stopMs >= gapMs) break; // real gap => break taken
    streakStart = prev.startMs;
  }

  return { working: true, seconds: (nowMs - streakStart) / MS };
}

/** A span of time with no time entry at all (any project) — "unreported" time. */
export interface Gap {
  startMs: number;
  stopMs: number;
  seconds: number;
}

/**
 * Holes in the timeline within [fromMs, toMs) where *no* entry (any project) was
 * running — i.e. unreported time. Only gaps *between* entries count: time before
 * the first entry or after the last is ignored (you simply weren't tracking
 * then). Entries are clipped to the window and overlapping ones merged first, so
 * the result is the true gaps. Gaps shorter than `minMinutes` are dropped as
 * noise (e.g. a few seconds between back-to-back entries).
 */
export function unreportedGaps(
  entries: NormEntry[],
  fromMs: number,
  toMs: number,
  minMinutes = UNREPORTED_MIN_MINUTES
): Gap[] {
  const spans = entries
    .map((e) => ({ a: Math.max(e.startMs, fromMs), b: Math.min(e.stopMs, toMs) }))
    .filter((s) => s.b > s.a)
    .sort((s1, s2) => s1.a - s2.a);
  if (spans.length === 0) return [];

  // Merge overlapping / touching spans so a gap is a genuine hole, not just the
  // boundary between two adjacent entries.
  const merged: { a: number; b: number }[] = [{ ...spans[0] }];
  for (let i = 1; i < spans.length; i++) {
    const last = merged[merged.length - 1];
    if (spans[i].a <= last.b) last.b = Math.max(last.b, spans[i].b);
    else merged.push({ ...spans[i] });
  }

  const minMs = minMinutes * 60 * MS;
  const gaps: Gap[] = [];
  for (let i = 1; i < merged.length; i++) {
    const startMs = merged[i - 1].b;
    const stopMs = merged[i].a;
    if (stopMs - startMs >= minMs) {
      gaps.push({ startMs, stopMs, seconds: (stopMs - startMs) / MS });
    }
  }
  return gaps;
}

export function fmtHM(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function fmtTimeOfDay(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
