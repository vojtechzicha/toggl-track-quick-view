// Pure calculation helpers for the quick view. Kept free of React / DOM so the
// logic is easy to reason about (and unit-test) in isolation.

export const WEEKLY_HOURS = 40; // weekly goal both modes aim for
export const STANDARD_DAY_HOURS = 8; // regular-week Mon–Wed target, and weekend fallback (both modes)
export const SHORT_MIDWEEK_HOURS = 9; // short-week Mon/Tue/Wed target
export const REGULAR_THU_FLOOR_HOURS = 7; // regular-week Thursday never below this
export const SHORT_THU_MIN_HOURS = 8; // short-week Thursday clamp floor
export const SHORT_THU_MAX_HOURS = 9; // short-week Thursday clamp ceiling
export const FRIDAY_RESERVE_HOURS = 5; // short-week Thursday leaves this much for Friday
export const FRIDAY_MIN_HOURS = 5; // Friday target never below this (both modes)
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
  tags?: string[]; // Toggl v9 returns tag *names* on the entry
}

// ---- Billing tags ----
// A "billing tag" identifies which line a tracked entry bills to. By convention
// these tag names start with "D" (e.g. "D123"). Every entry on the selected
// project is expected to carry one; the dashboard and timesheet flag the ones
// that don't so they can be fixed in Toggl.
export const BILLING_TAG_PREFIX = 'D';

/** The first billing tag (name starting with the prefix) on an entry, or null. */
export function billingTagOf(tags?: string[]): string | null {
  if (!tags) return null;
  return tags.find((t) => t.startsWith(BILLING_TAG_PREFIX)) ?? null;
}

/** True when an entry carries at least one billing tag. */
export function hasBillingTag(tags?: string[]): boolean {
  return billingTagOf(tags) !== null;
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
 * Project time (seconds) scheduled *strictly after* `nowMs` within [nowMs, untilMs).
 *
 * "Scheduled later" = entries on `projectId` whose start is in the future — work
 * you've planned but not done yet. An entry that merely *covers* now (started in
 * the past, ends in the future) is deliberately excluded: its remaining tail is
 * live work-in-progress, not separately-bankable scheduled time, and counting it
 * here would double-discount the day's remaining live work.
 */
export function scheduledLaterSeconds(
  entries: NormEntry[],
  projectId: number,
  nowMs: number,
  untilMs: number
): number {
  let total = 0;
  for (const e of entries) {
    if (e.projectId !== projectId) continue;
    if (e.startMs <= nowMs) continue; // covering-now or already past — not "later"
    const b = Math.min(e.stopMs, untilMs);
    if (b > e.startMs) total += (b - e.startMs) / MS;
  }
  return total;
}

/**
 * The selected-project entry whose span contains `nowMs` but that isn't the live
 * running timer — i.e. a pre-entered ("planned") block you're currently inside.
 * Running entries are excluded (normalize() clamps their stop to now, so they
 * never satisfy stop > now) since the live-tracking path already handles those.
 */
export function coveringEntry(
  entries: NormEntry[],
  projectId: number,
  nowMs: number
): NormEntry | null {
  return (
    entries.find(
      (e) => e.projectId === projectId && !e.running && e.startMs <= nowMs && e.stopMs > nowMs
    ) ?? null
  );
}

/**
 * Today's target in seconds.
 *
 * Both modes aim for a 40h week in three stages — Mon–Wed, Thursday, Friday —
 * and a day's target is fixed for the whole day: it depends only on the selected
 * project's hours logged *before* today (Mon 00:00 → today 00:00), so it does not
 * shrink as you work today.
 *
 * Regular week (shortFriday = false):
 *   - Mon/Tue/Wed: 8h each.
 *   - Thursday: half of the time remaining to reach 40h, but no less than 7h.
 *   - Friday: whatever remains to reach 40h, but no less than 5h.
 *
 * Short week (shortFriday = true):
 *   - Mon/Tue/Wed: 9h each.
 *   - Thursday: the time remaining to reach 40h minus a reserved 5h for Friday,
 *       clamped to [8h, 9h].
 *   - Friday: whatever remains to reach 40h, but no less than 5h.
 *
 * In both modes the weekend falls back to 8h, and every day is finally clamped
 * to at most 12h so an unusual week stays sane.
 */
export function dailyTargetSeconds(
  now: Date,
  entries: NormEntry[],
  projectId: number,
  shortFriday: boolean
): number {
  const day = now.getDay();
  const max = MAX_DAILY_TARGET_HOURS * HOUR;

  if (day === 1 || day === 2 || day === 3) {
    const midweek = shortFriday ? SHORT_MIDWEEK_HOURS : STANDARD_DAY_HOURS;
    return midweek * HOUR;
  }

  if (day === 4 || day === 5) {
    const weekStart = startOfWeekMonday(now).getTime();
    const todayStart = startOfDay(now).getTime();
    const loggedSoFar = projectSecondsInRange(entries, projectId, weekStart, todayStart);
    const remaining = WEEKLY_HOURS * HOUR - loggedSoFar;

    if (day === 4) {
      const target = shortFriday
        ? clamp(remaining - FRIDAY_RESERVE_HOURS * HOUR, SHORT_THU_MIN_HOURS * HOUR, SHORT_THU_MAX_HOURS * HOUR)
        : Math.max(remaining / 2, REGULAR_THU_FLOOR_HOURS * HOUR);
      return clamp(target, 0, max);
    }

    // Friday (both modes): whatever's left to reach 40h, floored at 5h.
    const target = Math.max(remaining, FRIDAY_MIN_HOURS * HOUR);
    return clamp(target, 0, max);
  }

  return STANDARD_DAY_HOURS * HOUR; // weekend
}

/**
 * The fixed, nominal target for a weekday assuming every day hits its goal —
 * i.e. the plain 40h plan (regular 8/8/8/8/8, short 9/9/9/8/5). Friday is fixed
 * (8h regular, 5h short) and Thursday is "the rest" (8h in both). Used to show a
 * stable target for days that haven't happened yet, where the adaptive
 * dailyTargetSeconds would otherwise swing to the clamp for want of logged time.
 */
export function plannedTargetSeconds(dayOfWeek: number, shortFriday: boolean): number {
  switch (dayOfWeek) {
    case 1: // Mon
    case 2: // Tue
    case 3: // Wed
      return (shortFriday ? SHORT_MIDWEEK_HOURS : STANDARD_DAY_HOURS) * HOUR;
    case 4: // Thu — the rest, which nets to 8h in both the regular and short plan
      return (shortFriday ? SHORT_THU_MIN_HOURS : STANDARD_DAY_HOURS) * HOUR;
    case 5: // Fri — fixed
      return (shortFriday ? FRIDAY_MIN_HOURS : STANDARD_DAY_HOURS) * HOUR;
    default: // weekend fallback
      return STANDARD_DAY_HOURS * HOUR;
  }
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

/** A half-open [a, b) interval in milliseconds. */
export interface Interval {
  a: number;
  b: number;
}

/** Merge overlapping or touching intervals into disjoint spans, sorted by start. */
export function mergeIntervals(spans: Interval[]): Interval[] {
  const sorted = spans.filter((s) => s.b > s.a).sort((x, y) => x.a - y.a);
  const out: Interval[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.a <= last.b) last.b = Math.max(last.b, s.b);
    else out.push({ ...s });
  }
  return out;
}

/** The parts of `base` intervals not covered by any `cut` interval. */
export function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  const cuts = mergeIntervals(cut);
  const out: Interval[] = [];
  for (const span of mergeIntervals(base)) {
    let start = span.a;
    for (const c of cuts) {
      if (c.b <= start || c.a >= span.b) continue; // no overlap with what's left
      if (c.a > start) out.push({ a: start, b: c.a });
      start = Math.max(start, c.b);
      if (start >= span.b) break;
    }
    if (start < span.b) out.push({ a: start, b: span.b });
  }
  return out;
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
  // Merge to genuine coverage spans so a gap is a real hole, not just the
  // boundary between two adjacent entries.
  const merged = mergeIntervals(
    entries.map((e) => ({ a: Math.max(e.startMs, fromMs), b: Math.min(e.stopMs, toMs) }))
  );

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
