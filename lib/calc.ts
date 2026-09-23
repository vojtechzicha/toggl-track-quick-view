// Pure calculation helpers for the quick view (no React or DOM).

// ---- Weekly workload model ----
// Every hour value below is for a 40h week and is scaled linearly by
// weeklyHours / 40 (see resolveTargets), so a 20h week becomes 4/4/4/4/4, or
// 4.5/4.5/4.5/4/2.5 with Short Friday. Two values can be overridden in
// WeekConfig: the Friday floor (`minWorkingDayHours`) and the per-line billable
// cap (`maxBillableHours`). A null override means the proportional default.
export const BASELINE_WEEKLY_HOURS = 40;
export const DEFAULT_WEEKLY_HOURS = 40;

// 40h-week values. Read them through resolveTargets.
const BASE_STANDARD_DAY_HOURS = 8; // regular-week Mon–Wed, and weekend fallback (= week / 5)
const BASE_SHORT_MIDWEEK_HOURS = 9; // short-week Mon/Tue/Wed target
const BASE_REGULAR_THU_FLOOR_HOURS = 7; // regular-week Thursday never below this
const BASE_SHORT_THU_MIN_HOURS = 8; // short-week Thursday clamp floor
const BASE_SHORT_THU_MAX_HOURS = 9; // short-week Thursday clamp ceiling
const BASE_FRIDAY_RESERVE_HOURS = 5; // short-week Thursday leaves this much for Friday
const BASE_FRIDAY_MIN_HOURS = 5; // Friday target floor, both modes (overridable)
const BASE_MAX_DAILY_TARGET_HOURS = 12; // ceiling for any daily target
const BASE_MAX_BILLABLE_HOURS = 4; // max length of one billed line (overridable)

// Not scaled by the weekly load: the break reminder is an ergonomic limit, and
// the others are detection thresholds.
export const BREAK_AFTER_HOURS = 4.5; // break reminder after this much continuous work
export const BREAK_GAP_MINUTES = 10; // a gap of at least this long counts as a break
export const UNREPORTED_MIN_MINUTES = 1; // shorter gaps are ignored as noise

const HOUR = 3600;
const MS = 1000;

/**
 * Workload settings that drive every target. `weeklyHours` scales the whole
 * model. A null override follows `weeklyHours`; a set override is absolute
 * hours and does not change when `weeklyHours` does.
 */
export interface WeekConfig {
  weeklyHours: number;
  maxBillableHours: number | null; // null → proportional default
  minWorkingDayHours: number | null; // null → proportional default (the Friday floor)
}

export const DEFAULT_WEEK_CONFIG: WeekConfig = {
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  maxBillableHours: null,
  minWorkingDayHours: null,
};

/** A baseline (40h-week) hour value scaled to the configured weekly load. */
function scaleHours(baseHours: number, weeklyHours: number): number {
  return (baseHours * weeklyHours) / BASELINE_WEEKLY_HOURS;
}

/** The proportional default for the timesheet cap at a given weekly load. */
export function defaultMaxBillableHours(weeklyHours: number): number {
  return scaleHours(BASE_MAX_BILLABLE_HOURS, weeklyHours);
}

/** The proportional default for the Friday floor at a given weekly load. */
export function defaultMinWorkingDayHours(weeklyHours: number): number {
  return scaleHours(BASE_FRIDAY_MIN_HOURS, weeklyHours);
}

/** Resolved timesheet cap in hours: the override if set, else the proportional default. */
export function effectiveMaxBillableHours(cfg: WeekConfig): number {
  return cfg.maxBillableHours ?? defaultMaxBillableHours(cfg.weeklyHours);
}

/** Resolved Friday floor in hours: the override if set, else the proportional default. */
export function effectiveMinWorkingDayHours(cfg: WeekConfig): number {
  return cfg.minWorkingDayHours ?? defaultMinWorkingDayHours(cfg.weeklyHours);
}

/** Every target threshold the daily/weekly model needs, resolved to seconds. */
interface ResolvedTargets {
  weekly: number;
  standardDay: number;
  shortMidweek: number;
  regularThuFloor: number;
  shortThuMin: number;
  shortThuMax: number;
  fridayReserve: number;
  fridayMin: number;
  maxDaily: number;
}

function resolveTargets(cfg: WeekConfig): ResolvedTargets {
  const w = cfg.weeklyHours;
  return {
    weekly: w * HOUR,
    standardDay: scaleHours(BASE_STANDARD_DAY_HOURS, w) * HOUR,
    shortMidweek: scaleHours(BASE_SHORT_MIDWEEK_HOURS, w) * HOUR,
    regularThuFloor: scaleHours(BASE_REGULAR_THU_FLOOR_HOURS, w) * HOUR,
    shortThuMin: scaleHours(BASE_SHORT_THU_MIN_HOURS, w) * HOUR,
    shortThuMax: scaleHours(BASE_SHORT_THU_MAX_HOURS, w) * HOUR,
    // The Thursday reserve ignores the Friday-floor override.
    fridayReserve: scaleHours(BASE_FRIDAY_RESERVE_HOURS, w) * HOUR,
    fridayMin: effectiveMinWorkingDayHours(cfg) * HOUR,
    maxDaily: scaleHours(BASE_MAX_DAILY_TARGET_HOURS, w) * HOUR,
  };
}

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
// A billing tag names the line an entry bills to. It is a tag starting with a
// configurable prefix (default "D", e.g. "D123"). Every entry on the selected
// project should carry one; the dashboard and timesheet flag those that don't.
export const DEFAULT_BILLING_TAG_PREFIX = 'D';

/** The given prefix, or the default when it is missing or empty. */
function tagPrefix(prefix?: string): string {
  return prefix && prefix.length > 0 ? prefix : DEFAULT_BILLING_TAG_PREFIX;
}

/** The first billing tag (name starting with the prefix) on an entry, or null. */
export function billingTagOf(tags?: string[], prefix?: string): string | null {
  if (!tags) return null;
  const p = tagPrefix(prefix);
  return tags.find((t) => t.startsWith(p)) ?? null;
}

/** All billing tags (names starting with the prefix) on an entry. */
export function billingTagsOf(tags?: string[], prefix?: string): string[] {
  if (!tags) return [];
  const p = tagPrefix(prefix);
  return tags.filter((t) => t.startsWith(p));
}

// ---- Overtime markers ----
// A billing code ending in one of these suffixes carries an overtime-trim
// marker (see lib/timesheet/overtime):
//   "(X)": trimmed first when a contract does not allow billing overtime.
//   "(!)": never trimmed. It still counts toward the cap, so the cut falls on
//          other lines.
// The suffixes are internal. They are stripped from every displayed and
// exported code, so `D123(X)` and `D123(!)` merge into the same `D123` line.
export const OVERTIME_TAG_SUFFIX = '(X)';
export const NO_TRIM_TAG_SUFFIX = '(!)';

/**
 * Remove every parenthetical group from a billing code: `D123 (Phase 2)` →
 * `D123`. A code that is only parentheticals is returned unchanged, so it never
 * becomes empty. Interpret the overtime markers before calling this (as
 * parseBillingCode does), or they are stripped too.
 */
export function stripCodeParens(code: string): string {
  const stripped = code
    .replace(/\s*\([^()]*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return stripped || code;
}

/**
 * Split a billing code into its displayed base and its overtime marker.
 * `D123(X)` and `D123 (X)` both give base `D123` with trimmable=true;
 * `D123(!)` gives `D123` with neverTrim=true.
 *
 * With `stripParens` (the workspace's "strip parentheses" setting) the base also
 * loses its remaining parenthetical groups: `D123 (Phase 2)(!)` → `D123` with
 * neverTrim=true. The marker is read before stripping, so the setting cannot
 * remove it.
 */
export function parseBillingCode(
  code: string,
  stripParens = false
): {
  base: string;
  trimmable: boolean;
  neverTrim: boolean;
} {
  let base = code;
  let trimmable = false;
  let neverTrim = false;
  if (code.endsWith(OVERTIME_TAG_SUFFIX)) {
    base = code.slice(0, -OVERTIME_TAG_SUFFIX.length).trimEnd();
    trimmable = true;
  } else if (code.endsWith(NO_TRIM_TAG_SUFFIX)) {
    base = code.slice(0, -NO_TRIM_TAG_SUFFIX.length).trimEnd();
    neverTrim = true;
  }
  if (stripParens) base = stripCodeParens(base);
  return { base, trimmable, neverTrim };
}

/** True when an entry carries at least one billing tag. */
export function hasBillingTag(tags?: string[], prefix?: string): boolean {
  return billingTagOf(tags, prefix) !== null;
}

// ---- Support tickets ----
// Support work is billed per ticket, and creating a tag for each ticket is
// impractical. An entry with no billing tag whose description starts with a
// bracketed id ("[T-123] Fix login") bills to that id: the bracket content
// becomes the billing code and the bracket is dropped from the billed
// description. A billing tag takes precedence. Applies in Toggl and standalone
// mode. Overtime markers work inside the bracket too ("[T-123(X)] …").
const SUPPORT_TICKET_RE = /^\s*\[([^\]]+)\]\s*/;

/**
 * The support-ticket id opening a description, split off from the rest, or
 * null when the description doesn't start with a (non-empty) bracket.
 */
export function supportTicket(description?: string): { code: string; rest: string } | null {
  const m = description?.match(SUPPORT_TICKET_RE);
  const code = m?.[1].trim();
  if (!m || !code) return null;
  return { code, rest: (description as string).slice(m[0].length) };
}

/** The support-ticket id opening a description, or null. */
export function supportTicketCode(description?: string): string | null {
  return supportTicket(description)?.code ?? null;
}

// ---- Time off (public holidays etc.) ----
// An entry with the time-off tag makes its day a holiday, treated like a
// weekend day: 0h expected, and the weekly goal and the no-overtime cap drop by
// weeklyHours / 5. The marker entry is never billed, counted or exported, and
// its duration is ignored. Other entries on that day count normally and are
// billed in full on top of the reduced cap, like weekend work.
export const DEFAULT_TIME_OFF_TAG = '.Time Off';

/** The time-off tag, lower-cased, or the default when missing or empty. */
function timeOffMarker(tag?: string): string {
  const t = tag?.trim();
  return t && t.length > 0 ? t.toLowerCase() : DEFAULT_TIME_OFF_TAG.toLowerCase();
}

/** True when an entry carries the time-off tag (case-insensitive). */
export function isTimeOffEntry(tags: string[] | undefined, timeOffTag?: string): boolean {
  if (!tags) return false;
  const marker = timeOffMarker(timeOffTag);
  return tags.some((t) => t.trim().toLowerCase() === marker);
}

/** Day indices (0=Sat … 6=Fri) that hold a non-working day beyond the weekend. */
export type HolidaySet = ReadonlySet<number>;
const NO_HOLIDAYS: HolidaySet = new Set<number>();

/**
 * Indices (0=Sat … 6=Fri) of days with a time-off entry on a selected project.
 * Only the selection counts: a day can be time off in one workspace and a
 * working day in another.
 */
export function holidayDaysOfWeek(
  entries: TimeEntry[],
  projects: ProjectSet,
  weekStart: number,
  timeOffTag?: string
): Set<number> {
  const dayMs = 24 * HOUR * MS;
  const days = new Set<number>();
  for (const e of entries) {
    if (!inSet(e.project_id, projects)) continue;
    if (!isTimeOffEntry(e.tags, timeOffTag)) continue;
    const startMs = new Date(e.start).getTime();
    if (!Number.isFinite(startMs)) continue;
    const dayIdx = Math.floor((startMs - weekStart) / dayMs);
    if (dayIdx >= 0 && dayIdx <= 6) days.add(dayIdx);
  }
  return days;
}

/** Entry with absolute millisecond bounds. A running entry stops at "now". */
export interface NormEntry {
  id: number;
  startMs: number;
  stopMs: number;
  projectId: number | null;
  running: boolean;
}

/**
 * The selected project ids. They are pooled as one project for tracking and
 * targets; only the timesheet views split them.
 */
export type ProjectSet = ReadonlySet<number>;

/** True when an entry's project (possibly null) is one of the selected ones. */
function inSet(projectId: number | null, projects: ProjectSet): boolean {
  return projectId != null && projects.has(projectId);
}

/**
 * Normalise entries to ms bounds, sorted by start. When `timeOffTag` is given,
 * time-off markers are dropped because they are not tracked work.
 */
export function normalize(entries: TimeEntry[], nowMs: number, timeOffTag?: string): NormEntry[] {
  return entries
    .filter((e) => timeOffTag === undefined || !isTimeOffEntry(e.tags, timeOffTag))
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

/**
 * Saturday 00:00 (local) of the week containing `d`. Weeks start on Saturday,
 * so a weekend belongs to the Mon–Fri that follows it.
 */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 Sun .. 6 Sat
  // Days since Saturday: Sat→0, Sun→1, Mon→2 … Fri→6.
  const diff = (day + 1) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}

// ---- Month-split weeks ----
// Billing is per month, so when the 1st falls mid-week the week splits in two,
// as the timesheet's overtime cap does (weekSegments in lib/timesheet/overtime).
// Each side is a separate mini-week with a budget of weeklyHours / 5 per
// weekday it contains. Hours logged on one side never count toward the other,
// so overtime in the old month does not shorten the new month's days.

/** Day index within the Sat-start week: Sat→0, Sun→1, Mon→2 … Fri→6. */
function weekDayIndex(d: Date): number {
  return (d.getDay() + 1) % 7;
}

/** The first day index (1…6) whose calendar month differs from the week's first day, or null. */
export function monthSplitDay(weekStart: number): number | null {
  const monthKey = (d: number) => {
    // setDate stays on local calendar days; fixed-ms day math would drift
    // across a DST change.
    const dt = new Date(weekStart);
    dt.setDate(dt.getDate() + d);
    return dt.getFullYear() * 12 + dt.getMonth();
  };
  const first = monthKey(0);
  for (let d = 1; d <= 6; d++) {
    if (monthKey(d) !== first) return d;
  }
  return null;
}

/** The stretch of the week (inclusive day indices) sharing `dayIdx`'s calendar month. */
function segmentOf(dayIdx: number, split: number | null): { startDay: number; endDay: number } {
  if (split === null) return { startDay: 0, endDay: 6 };
  return dayIdx < split ? { startDay: 0, endDay: split - 1 } : { startDay: split, endDay: 6 };
}

/**
 * Seconds of selected-project entries overlapping [fromMs, toMs). A running
 * entry counts up to its stop, which normalize() set to now.
 */
export function projectSecondsInRange(
  entries: NormEntry[],
  projects: ProjectSet,
  fromMs: number,
  toMs: number
): number {
  let total = 0;
  for (const e of entries) {
    if (!inSet(e.projectId, projects)) continue;
    const a = Math.max(e.startMs, fromMs);
    const b = Math.min(e.stopMs, toMs);
    if (b > a) total += (b - a) / MS;
  }
  return total;
}

/**
 * Seconds of selected-project entries that start after `nowMs`, clipped to
 * `untilMs`: work planned but not yet done. An entry that covers now is
 * excluded; its remaining part is work in progress, and counting it here would
 * discount it twice.
 */
export function scheduledLaterSeconds(
  entries: NormEntry[],
  projects: ProjectSet,
  nowMs: number,
  untilMs: number
): number {
  let total = 0;
  for (const e of entries) {
    if (!inSet(e.projectId, projects)) continue;
    if (e.startMs <= nowMs) continue; // started already
    const b = Math.min(e.stopMs, untilMs);
    if (b > e.startMs) total += (b - e.startMs) / MS;
  }
  return total;
}

/**
 * A stopped selected-project entry whose span contains `nowMs`: a planned
 * block you are currently inside. Running entries never match, because
 * normalize() sets their stop to now.
 */
export function coveringEntry(
  entries: NormEntry[],
  projects: ProjectSet,
  nowMs: number
): NormEntry | null {
  return (
    entries.find(
      (e) => inSet(e.projectId, projects) && !e.running && e.startMs <= nowMs && e.stopMs > nowMs
    ) ?? null
  );
}

/**
 * A segment's working-day indices in order: its weekdays (idx ≥ 2) minus
 * holidays.
 */
function workingDaysOfSegment(
  seg: { startDay: number; endDay: number },
  holidays: HolidaySet
): number[] {
  const days: number[] = [];
  for (let d = Math.max(seg.startDay, 2); d <= seg.endDay; d++) {
    if (!holidays.has(d)) days.push(d);
  }
  return days;
}

/**
 * Target for a working day from its position in the segment and the time still
 * remaining in the segment's budget:
 * - last working day ("Friday"): all that remains, at least the Friday floor;
 * - second to last ("Thursday"): half the remainder (regular) or the remainder
 *   minus the Friday reserve, clamped (short);
 * - earlier days: the fixed base day.
 * In a normal week these are Fri, Thu and Mon–Wed; a Friday holiday moves the
 * closing role to Thursday. Clamped to the daily maximum.
 */
function positionTarget(
  dayIdx: number,
  workingDays: number[],
  remaining: number,
  shortFriday: boolean,
  t: ResolvedTargets
): number {
  let target: number;
  if (dayIdx === workingDays[workingDays.length - 1]) {
    target = Math.max(remaining, t.fridayMin);
  } else if (workingDays.length > 1 && dayIdx === workingDays[workingDays.length - 2]) {
    target = shortFriday
      ? clamp(remaining - t.fridayReserve, t.shortThuMin, t.shortThuMax)
      : Math.max(remaining / 2, t.regularThuFloor);
  } else {
    target = shortFriday ? t.shortMidweek : t.standardDay;
  }
  return clamp(target, 0, t.maxDaily);
}

/**
 * Today's target in seconds.
 *
 * The target is fixed for the whole day. It depends only on selected-project
 * hours logged from the segment's start to today 00:00 (so weekend work at the
 * start of the week counts toward Thu/Fri), and does not shrink as you work
 * today. Hours below are for a 40h week, scaled by weeklyHours / 40.
 *
 * Regular week:
 *   - Mon–Wed: 8h (week / 5).
 *   - Thu: half of what remains of the weekly total, at least 7h.
 *   - Fri: all that remains, at least the Friday floor (5h, overridable).
 *
 * Short Friday:
 *   - Mon–Wed: 9h.
 *   - Thu: what remains minus 5h reserved for Friday, clamped to [8h, 9h].
 *   - Fri: all that remains, at least the Friday floor.
 *
 * Month split (see monthSplitDay): each segment has its own budget of
 * weeklyHours / 5 per weekday and counts only hours logged inside it. The
 * Thu/Fri roles move to the segment's last two working days.
 *
 * Holidays (see isTimeOffEntry): target 0h, no budget, and the Thu/Fri roles
 * move to the last working days.
 *
 * Weekend days return the standard day. Every target is clamped to 12h (scaled).
 */
export function dailyTargetSeconds(
  now: Date,
  entries: NormEntry[],
  projects: ProjectSet,
  shortFriday: boolean,
  cfg: WeekConfig,
  holidays: HolidaySet = NO_HOLIDAYS
): number {
  const t = resolveTargets(cfg);
  const idx = weekDayIndex(now);
  if (idx < 2) return t.standardDay; // weekend
  if (holidays.has(idx)) return 0;

  const weekStart = startOfWeek(now);
  const seg = segmentOf(idx, monthSplitDay(weekStart.getTime()));
  const workingDays = workingDaysOfSegment(seg, holidays);
  const pos = workingDays.indexOf(idx);
  // Base days are fixed.
  if (pos < workingDays.length - 2) return shortFriday ? t.shortMidweek : t.standardDay;

  const budget = t.standardDay * workingDays.length; // weekends and holidays add nothing
  const segStart = new Date(weekStart);
  segStart.setDate(segStart.getDate() + seg.startDay);
  const loggedSoFar = projectSecondsInRange(
    entries,
    projects,
    segStart.getTime(),
    startOfDay(now).getTime()
  );
  return positionTarget(idx, workingDays, budget - loggedSoFar, shortFriday, t);
}

/**
 * The planned target for a day, assuming every earlier day hit its target:
 * regular 8/8/8/8/8, short 9/9/9/8/5 (scaled). It walks the day's segment, so
 * month splits come out right (a Friday alone in the new month plans a full
 * standard day). Used for future days, where dailyTargetSeconds would hit the
 * clamp because nothing is logged yet.
 */
export function plannedTargetSeconds(
  date: Date,
  shortFriday: boolean,
  cfg: WeekConfig,
  holidays: HolidaySet = NO_HOLIDAYS
): number {
  const t = resolveTargets(cfg);
  const idx = weekDayIndex(date);
  if (idx < 2) return t.standardDay; // weekend
  if (holidays.has(idx)) return 0;

  const seg = segmentOf(idx, monthSplitDay(startOfWeek(date).getTime()));
  const workingDays = workingDaysOfSegment(seg, holidays);
  const budget = t.standardDay * workingDays.length;

  let planned = 0;
  for (const d of workingDays) {
    const target = positionTarget(d, workingDays, budget - planned, shortFriday, t);
    if (d === idx) return target;
    planned += target;
  }
  return t.standardDay; // unreachable: idx is a working day of its segment
}

/**
 * How long you have worked on the selected projects without a break.
 *
 * `working` is false unless a selected-project entry is running. The streak
 * walks back from now through selected-project entries and ends at the first
 * gap of at least BREAK_GAP_MINUTES. Other projects are ignored: an overlapping
 * entry elsewhere is not a break, and switching away leaves a gap in the
 * selected coverage anyway. Moving between selected projects is one streak.
 */
export function continuousWorkSeconds(
  entries: NormEntry[],
  projects: ProjectSet,
  nowMs: number
): { working: boolean; seconds: number } {
  const working = entries.some((e) => e.running && inSet(e.projectId, projects));
  if (!working) return { working: false, seconds: 0 };

  const gapMs = BREAK_GAP_MINUTES * 60 * MS;

  // Walk from latest to earliest, extending the streak while each entry ends
  // within gapMs of it. The running entry stops at now (normalize()).
  const spans = entries
    .filter((e) => inSet(e.projectId, projects))
    .sort((a, b) => a.startMs - b.startMs);

  let streakStart = nowMs;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (s.stopMs < streakStart - gapMs) break; // a break
    if (s.startMs < streakStart) streakStart = s.startMs;
  }

  return { working: true, seconds: (nowMs - streakStart) / MS };
}

/** A span with no time entry on any project ("unreported" time). */
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
 * Gaps within [fromMs, toMs) where no entry on any project was running. Only
 * gaps between entries count; time before the first or after the last entry is
 * ignored. Gaps shorter than `minMinutes` are dropped as noise.
 */
export function unreportedGaps(
  entries: NormEntry[],
  fromMs: number,
  toMs: number,
  minMinutes = UNREPORTED_MIN_MINUTES
): Gap[] {
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

export const QUARTER_SECONDS = 15 * 60; // default rounding unit
export const DEFAULT_ROUNDING_HOURS = 0.25;
// Rounding units a user can pick, in hours. 0.2 (12 min) is for clients that
// cannot enter quarter-hours; 1 is for clients that bill whole hours.
export const ROUNDING_HOURS_OPTIONS = [0.25, 0.2, 0.5, 1] as const;

/** Convert a rounding granularity in hours (e.g. 0.25) to whole seconds (900). */
export function roundingUnitSeconds(hours: number): number {
  return Math.round((hours > 0 ? hours : DEFAULT_ROUNDING_HOURS) * 3600);
}

// Grids (hours) the Individual view can snap a line's start time to,
// independent of the rounding unit. Some clients take 15-min durations but only
// accept start times on :00 or :30. Null means "use the rounding unit"; a
// window at or below the rounding unit has the same effect.
export const START_WINDOW_HOURS_OPTIONS = [0.25, 0.5, 1] as const;

/**
 * The start-time grid in seconds: the workspace's start window when it is
 * coarser than the rounding unit, else the rounding unit.
 */
export function startWindowUnitSeconds(
  windowHours: number | null | undefined,
  roundingSeconds: number
): number {
  const window = windowHours && windowHours > 0 ? Math.round(windowHours * 3600) : 0;
  return window > roundingSeconds ? window : roundingSeconds;
}

/**
 * Round durations (seconds) to whole units (`unitSeconds`, default 15 min) so
 * the rounded values sum to the rounded total.
 *
 * The total is rounded to the nearest unit and each value floored. The spare
 * units go one at a time to the values with the largest remainder
 * (largest-remainder / Hamilton method). Negative values count as 0. Returns
 * seconds in input order.
 *
 * With `biasZero`, spare units go first to values that would floor to zero, so
 * the Individual view can show small entries. Such a value can still end at
 * zero when spare units run out; the caller decides whether to drop it.
 */
export function roundQuartersPreservingTotal(
  secs: number[],
  opts: { biasZero?: boolean; unitSeconds?: number } = {}
): number[] {
  const unit = opts.unitSeconds && opts.unitSeconds > 0 ? opts.unitSeconds : QUARTER_SECONDS;
  const quarters = secs.map((s) => Math.max(0, s) / unit);
  const floors = quarters.map((q) => Math.floor(q));
  const target = Math.round(quarters.reduce((a, b) => a + b, 0));
  let extra = target - floors.reduce((a, b) => a + b, 0); // spare units, >= 0

  const order = quarters
    .map((q, i) => ({ i, r: q - floors[i], surface: opts.biasZero === true && floors[i] === 0 && q > 0 }))
    .sort((a, b) => {
      if (a.surface !== b.surface) return a.surface ? -1 : 1; // would-be zeros first
      return b.r - a.r; // then largest remainder
    });

  const out = floors.slice();
  for (let k = 0; k < order.length && extra > 0; k++, extra--) {
    out[order[k].i] += 1;
  }
  return out.map((q) => q * unit);
}

/** Compact hours label, e.g. 40 → "40h", 37.5 → "37.5h", 2.25 → "2.25h". */
export function fmtHoursLabel(hours: number): string {
  return `${Number(hours.toFixed(2))}h`;
}

/** Duration as decimal hours, e.g. 30000s → "8.33h". */
export function fmtHours(seconds: number): string {
  return `${(Math.max(0, seconds) / 3600).toFixed(2)}h`;
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
