// Pure calculation helpers for the quick view. Kept free of React / DOM so the
// logic is easy to reason about (and unit-test) in isolation.

// ---- Weekly workload model ----
// The whole targets model is tuned around a baseline 40h week. Every hour value
// below is expressed at that baseline and scaled linearly by weeklyHours / 40
// (see resolveTargets), so a shorter (or longer) week keeps the exact same shape
// — e.g. a 20h week becomes an even 4/4/4/4/4 or a short 4.5/4.5/4.5/4/2.5. Two
// of these values are also directly user-overridable via WeekConfig: the Friday
// floor ("minimal target working day") and the timesheet cap ("maximal
// individually billed timesheet"). When their override is null they fall back to
// the proportional default.
export const BASELINE_WEEKLY_HOURS = 40; // the week these base values were tuned for
export const DEFAULT_WEEKLY_HOURS = 40; // default for a fresh install

// Baseline (40h-week) hour values — private; always read through resolveTargets.
const BASE_STANDARD_DAY_HOURS = 8; // regular-week Mon–Wed, and weekend fallback (= week / 5)
const BASE_SHORT_MIDWEEK_HOURS = 9; // short-week Mon/Tue/Wed target
const BASE_REGULAR_THU_FLOOR_HOURS = 7; // regular-week Thursday never below this
const BASE_SHORT_THU_MIN_HOURS = 8; // short-week Thursday clamp floor
const BASE_SHORT_THU_MAX_HOURS = 9; // short-week Thursday clamp ceiling
const BASE_FRIDAY_RESERVE_HOURS = 5; // short-week Thursday leaves this much for Friday
const BASE_FRIDAY_MIN_HOURS = 5; // Friday target floor (both modes) — overridable
const BASE_MAX_DAILY_TARGET_HOURS = 12; // clamp so a bad week can't demand 16h
const BASE_MAX_BILLABLE_HOURS = 4; // a single billable line item can't exceed this — overridable

// Fixed thresholds — deliberately NOT scaled by the weekly load. The break
// reminder is an ergonomic limit (you shouldn't work this long straight no
// matter the week's size); the others are detection/rounding granularities.
export const BREAK_AFTER_HOURS = 4.5; // remind to take a break after this much continuous work
export const BREAK_GAP_MINUTES = 10; // a gap >= this counts as a real break
export const UNREPORTED_MIN_MINUTES = 1; // ignore gaps shorter than this as noise

const HOUR = 3600;
const MS = 1000;

/**
 * The user-facing workload settings that drive every target. `weeklyHours` is
 * the master dial that scales the whole model. The two override values default
 * (when null) to their proportional value, but once set they stay at the
 * absolute hours given — they do not move when weeklyHours later changes.
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
    // The short-week Thursday reserve scales purely with the weekly load; the
    // user's "minimal target working day" override governs only the Friday floor.
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
// A "billing tag" identifies which line a tracked entry bills to. By convention
// these tag names start with a single-letter prefix (default "D", e.g. "D123").
// The prefix is configurable in the advanced settings. Every entry on the
// selected project is expected to carry one; the dashboard and timesheet flag
// the ones that don't so they can be fixed in Toggl.
export const DEFAULT_BILLING_TAG_PREFIX = 'D';

/** The prefix to use, falling back to the default when none/empty is given. */
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
// A billing code ending in one of these literal suffixes carries an internal
// overtime-trim marker (see lib/timesheet/overtime):
//   "(X)" — trimmable: the first time to drop when a contract disallows billing
//           overtime.
//   "(!)" — never trimmed: the overtime cap must not touch this time; the cut
//           falls on the other lines instead (it still consumes the cap).
// Both suffixes are private — they're stripped from every displayed/exported
// code so a client never sees them, and `D123(X)` / `D123(!)` merge into the
// same displayed `D123` line as their plain twin.
export const OVERTIME_TAG_SUFFIX = '(X)';
export const NO_TRIM_TAG_SUFFIX = '(!)';

/**
 * Split a billing code into its displayed base and which internal overtime
 * marker it carries. The suffix (and any whitespace before it) is removed from
 * the base, so `D123(X)` and `D123 (X)` both display as `D123` with
 * trimmable=true, and `D123(!)` displays as `D123` with neverTrim=true.
 */
export function parseBillingCode(code: string): {
  base: string;
  trimmable: boolean;
  neverTrim: boolean;
} {
  if (code.endsWith(OVERTIME_TAG_SUFFIX)) {
    const base = code.slice(0, -OVERTIME_TAG_SUFFIX.length).trimEnd();
    return { base, trimmable: true, neverTrim: false };
  }
  if (code.endsWith(NO_TRIM_TAG_SUFFIX)) {
    const base = code.slice(0, -NO_TRIM_TAG_SUFFIX.length).trimEnd();
    return { base, trimmable: false, neverTrim: true };
  }
  return { base: code, trimmable: false, neverTrim: false };
}

/** True when an entry carries at least one billing tag. */
export function hasBillingTag(tags?: string[], prefix?: string): boolean {
  return billingTagOf(tags, prefix) !== null;
}

// ---- Support tickets ----
// Support work is billed per one-off ticket, so pre-creating a tag for every
// ticket is not practical. Instead, an entry that carries NO billing tag but
// whose description starts with a bracketed ticket id — "[T-123] Fix login" —
// bills to that id as if it were tagged: the bracket's content becomes the
// entry's billing code and the bracket itself is dropped from the billed
// description (the code already names the ticket). Always on, in every mode
// (Toggl and standalone); an explicit billing tag wins over the bracket, so
// ordinary tagged entries are unaffected. The derived code goes through the
// same downstream machinery as a real tag, so the "(X)"/"(!)" overtime
// markers work inside the bracket too ("[T-123(X)] …").
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

/** Just the support-ticket id opening a description, or null. */
export function supportTicketCode(description?: string): string | null {
  return supportTicket(description)?.code ?? null;
}

// ---- Time off (state holidays etc.) ----
// An entry carrying the time-off tag marks its whole day as a non-working day —
// a "holiday" that behaves exactly like a weekend: 0h expected, the weekly goal
// and the no-overtime cap drop by a day's worth (weeklyHours / 5). The marker
// entry itself is never billed, counted or exported; its duration is irrelevant.
// Any OTHER entry on such a day still counts normally — work done on a holiday
// is real work, billed in full on top of the reduced cap like weekend work.
export const DEFAULT_TIME_OFF_TAG = '.Time Off';

/** The effective time-off tag, falling back to the default when none/empty. */
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
 * The week's holiday days: indices (0=Sat … 6=Fri) of days on which a selected
 * project carries a time-off entry. Only the current selection counts — a day
 * can be time off in one workspace and a normal working day in another.
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

/** Normalised entry with absolute millisecond bounds (running => stop is "now"). */
export interface NormEntry {
  id: number;
  startMs: number;
  stopMs: number;
  projectId: number | null;
  running: boolean;
}

/**
 * The set of project ids that count as "the project". Multiple selected projects
 * behave as one for every tracking/target calculation — there's no distinction
 * between them here (the per-project split only matters in the timesheet views).
 */
export type ProjectSet = ReadonlySet<number>;

/** True when an entry's project (possibly null) is one of the selected ones. */
function inSet(projectId: number | null, projects: ProjectSet): boolean {
  return projectId != null && projects.has(projectId);
}

/**
 * Normalise entries to ms bounds. When `timeOffTag` is given, time-off marker
 * entries are dropped — they flag a holiday, they are not tracked work, so
 * nothing downstream (rings, targets, streaks, gaps) should ever count them.
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
 * Saturday 00:00 (local) of the week containing `d`. The week starts on Saturday,
 * so a weekend leads the week it belongs to (Sat/Sun sit *before* the following
 * Mon–Fri rather than trailing the preceding ones).
 */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const day = x.getDay(); // 0 Sun .. 6 Sat
  // Days since the most recent Saturday: Sat→0, Sun→1, Mon→2 … Fri→6.
  const diff = (day + 1) % 7;
  x.setDate(x.getDate() - diff);
  return x;
}

// ---- Month-split weeks ----
// Billing runs to month-end, so when the 1st of a month falls mid-week the week
// splits in two and each side settles against its own month — the same rule the
// timesheet's overtime cap uses (see weekSegments in lib/timesheet/overtime).
// The targets model follows suit: each side of the split is an independent
// mini-week with its own budget of weeklyHours/5 per weekday it contains, and
// hours logged on one side never bank against the other. That's what keeps
// overtime in the old month's half from (wrongly) shortening the new month's
// days — the old month's surplus is that month's business, not a credit here.

/** Day index within the Sat-start week: Sat→0, Sun→1, Mon→2 … Fri→6. */
function weekDayIndex(d: Date): number {
  return (d.getDay() + 1) % 7;
}

/** The first day index (1…6) whose calendar month differs from the week's first day, or null. */
export function monthSplitDay(weekStart: number): number | null {
  const monthKey = (d: number) => {
    // setDate keeps it on local calendar days, so a DST change at a month-end
    // midnight can't drift the boundary the way fixed-ms day math could.
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
 * Seconds spent on any selected project that overlap [fromMs, toMs). Overlap-based
 * so a running entry contributes live time as `toMs` (now) advances.
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
 * Project time (seconds) scheduled *strictly after* `nowMs` within [nowMs, untilMs).
 *
 * "Scheduled later" = selected-project entries whose start is in the future — work
 * you've planned but not done yet. An entry that merely *covers* now (started in
 * the past, ends in the future) is deliberately excluded: its remaining tail is
 * live work-in-progress, not separately-bankable scheduled time, and counting it
 * here would double-discount the day's remaining live work.
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
    if (e.startMs <= nowMs) continue; // covering-now or already past — not "later"
    const b = Math.min(e.stopMs, untilMs);
    if (b > e.startMs) total += (b - e.startMs) / MS;
  }
  return total;
}

/**
 * A selected-project entry whose span contains `nowMs` but that isn't the live
 * running timer — i.e. a pre-entered ("planned") block you're currently inside.
 * Running entries are excluded (normalize() clamps their stop to now, so they
 * never satisfy stop > now) since the live-tracking path already handles those.
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
 * The ordered working-day indices of a segment: its weekdays (Mon–Fri, idx ≥ 2)
 * minus any holidays. Weekends and holidays contribute no budget and take no
 * position — a holiday behaves exactly like a weekend day inside the model.
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
 * Target for one working day given its position within its segment's working
 * days and the segment time still unaccounted for. The segment's last working
 * day closes it out Friday-style (take everything remaining, never below the
 * floor); the second-to-last adapts Thursday-style (half the remainder regular,
 * reserve-clamped short); every earlier working day is a fixed base day. In a
 * whole-month week with no holidays these positions are literally Friday,
 * Thursday and Mon–Wed; a Friday holiday shifts the closing role to Thursday.
 * Always clamped to the daily maximum.
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
 * Both modes aim for the configured weekly total in three stages — base days,
 * an adaptive second-to-last day, an adaptive closing day — and a day's target
 * is fixed for the whole day: it depends only on the selected project's hours
 * logged *before* today (from the segment's start → today 00:00, so a weekend at
 * the week's start counts toward Thu/Fri), so it does not shrink as you work
 * today. Every hour figure below is the 40h-week baseline scaled by
 * weeklyHours / 40 (the Friday floor can be overridden).
 *
 * Regular week (shortFriday = false):
 *   - Mon/Tue/Wed: 8h each (week / 5).
 *   - Thursday: half of the time remaining to reach the weekly total, never below 7h.
 *   - Friday: whatever remains to reach the weekly total, but no less than the floor (5h).
 *
 * Short week (shortFriday = true):
 *   - Mon/Tue/Wed: 9h each.
 *   - Thursday: the time remaining minus a reserved 5h for Friday, clamped to [8h, 9h].
 *   - Friday: whatever remains, but no less than the floor (5h).
 *
 * Month rollover: when the 1st falls mid-week the week splits into two
 * independent segments (see monthSplitDay), each budgeted weeklyHours/5 per
 * weekday it holds — matching how the timesheet caps billing per month. The
 * adaptive Thursday/Friday roles shift to each segment's last two weekdays and
 * settle against the segment's own budget, counting only hours logged inside
 * that segment. So overtime banked before the boundary no longer (wrongly)
 * shortens the new month's days, and the old month's half absorbs its own
 * shortfall/surplus on its closing day instead.
 *
 * Holidays: days in `holidays` (marked by a time-off entry, see isTimeOffEntry)
 * are non-working days exactly like the weekend — their target is 0h, they add
 * no budget (the segment shrinks by weeklyHours/5 per holiday) and the adaptive
 * closing roles shift to the segment's last actual working days.
 *
 * In both modes the weekend falls back to the standard day, and every day is
 * finally clamped to at most 12h (scaled) so an unusual week stays sane.
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
  if (holidays.has(idx)) return 0; // holiday — no work expected

  const weekStart = startOfWeek(now);
  const seg = segmentOf(idx, monthSplitDay(weekStart.getTime()));
  const workingDays = workingDaysOfSegment(seg, holidays);
  const pos = workingDays.indexOf(idx);
  // Base days (more than two working days before the segment closes) are fixed
  // and need no pool arithmetic at all.
  if (pos < workingDays.length - 2) return shortFriday ? t.shortMidweek : t.standardDay;

  const budget = t.standardDay * workingDays.length; // Sat/Sun/holidays add nothing
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
 * The fixed, nominal target for a weekday assuming every day hits its goal —
 * i.e. the plain weekly plan (regular 8/8/8/8/8, short 9/9/9/8/5, all scaled).
 * Computed by walking the day's segment as if each prior day landed exactly on
 * target, so the adaptive positions see the pool the plan leaves them — which
 * also makes the plan come out right on a month-split week (e.g. a Friday alone
 * in the new month plans a full standard day, not a short one). Used to show a
 * stable target for days that haven't happened yet, where the adaptive
 * dailyTargetSeconds would otherwise swing to the clamp for want of logged time.
 */
export function plannedTargetSeconds(
  date: Date,
  shortFriday: boolean,
  cfg: WeekConfig,
  holidays: HolidaySet = NO_HOLIDAYS
): number {
  const t = resolveTargets(cfg);
  const idx = weekDayIndex(date);
  if (idx < 2) return t.standardDay; // weekend fallback
  if (holidays.has(idx)) return 0; // holiday — no work expected

  const seg = segmentOf(idx, monthSplitDay(startOfWeek(date).getTime()));
  const workingDays = workingDaysOfSegment(seg, holidays);
  const budget = t.standardDay * workingDays.length;

  let planned = 0;
  for (const d of workingDays) {
    const target = positionTarget(d, workingDays, budget - planned, shortFriday, t);
    if (d === idx) return target;
    planned += target;
  }
  return t.standardDay; // unreachable — idx is always a working day inside its segment
}

/**
 * How long you've been continuously working on the selected project(s) right now.
 *
 * Returns `working: false` unless a selected-project entry is currently running.
 * The streak is determined purely by the selected project(s)' own coverage:
 * starting from now it walks backwards through their entries and ends (i.e. a
 * break is detected) at the first real hole of >= BREAK_GAP_MINUTES.
 *
 * Entries outside the selection are ignored entirely — a *parallel* timesheet
 * that merely overlaps yours is not a break (you never stopped working on the
 * project), and a *sequential* switch away already shows up as a hole in the
 * selected coverage, so the gap rule still catches it. Because the selected
 * projects pool together, working straight across two of them is one streak.
 */
export function continuousWorkSeconds(
  entries: NormEntry[],
  projects: ProjectSet,
  nowMs: number
): { working: boolean; seconds: number } {
  const working = entries.some((e) => e.running && inSet(e.projectId, projects));
  if (!working) return { working: false, seconds: 0 };

  const gapMs = BREAK_GAP_MINUTES * 60 * MS;

  // Walk the selected project(s)' entries from latest to earliest, extending the
  // streak back as long as each entry's coverage reaches within gapMs of it. A
  // running entry is clamped to now by normalize(), so coverage always reaches
  // `nowMs`.
  const spans = entries
    .filter((e) => inSet(e.projectId, projects))
    .sort((a, b) => a.startMs - b.startMs);

  let streakStart = nowMs;
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (s.stopMs < streakStart - gapMs) break; // real gap before the streak => break taken
    if (s.startMs < streakStart) streakStart = s.startMs;
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

export const QUARTER_SECONDS = 15 * 60; // default timesheet rounding granularity (15 min)
export const DEFAULT_ROUNDING_HOURS = 0.25; // 15 minutes, the default rounding unit
// Granularities a user can pick (hours). 0.25 = 15 min; 0.2 = 12 min (some clients
// can't enter quarter-hours); 1 = a full hour (clients that bill in whole hours).
// All are exact divisors that keep figures tidy.
export const ROUNDING_HOURS_OPTIONS = [0.25, 0.2, 1] as const;
// The billable cap is per-config now; see effectiveMaxBillableHours / WeekConfig.

/** Convert a rounding granularity in hours (e.g. 0.25) to whole seconds (900). */
export function roundingUnitSeconds(hours: number): number {
  return Math.round((hours > 0 ? hours : DEFAULT_ROUNDING_HOURS) * 3600);
}

/**
 * Round a set of second-durations to whole rounding units (15 minutes by default,
 * or whatever `unitSeconds` is set to) so that the rounded values still **sum to
 * the rounded total** of the originals — i.e. rounding the parts never drifts away
 * from rounding the whole.
 *
 * The total is rounded to the nearest unit; each value is floored to a unit; then
 * the leftover units needed to reach the total are handed out one-by-one to the
 * values with the largest fractional remainder (the largest-remainder / Hamilton
 * method). That spreads the unavoidable rounding error as evenly as possible — the
 * parts closest to rounding up are the ones bumped up. Returns rounded seconds in
 * the input order.
 *
 * With `biasZero`, the spare units go **first** to values that would
 * otherwise floor to zero (a small entry the summary would silently drop),
 * so the individual view can surface them; the largest-remainder order only
 * breaks ties among that group and orders the rest. A value can still end up at
 * zero when there aren't enough spare units to reach it — the caller decides
 * whether to keep or drop it.
 */
export function roundQuartersPreservingTotal(
  secs: number[],
  opts: { biasZero?: boolean; unitSeconds?: number } = {}
): number[] {
  const unit = opts.unitSeconds && opts.unitSeconds > 0 ? opts.unitSeconds : QUARTER_SECONDS;
  const quarters = secs.map((s) => Math.max(0, s) / unit);
  const floors = quarters.map((q) => Math.floor(q));
  const target = Math.round(quarters.reduce((a, b) => a + b, 0)); // whole units in the total
  let extra = target - floors.reduce((a, b) => a + b, 0); // spare units to distribute (>= 0)

  const order = quarters
    .map((q, i) => ({ i, r: q - floors[i], surface: opts.biasZero === true && floors[i] === 0 && q > 0 }))
    .sort((a, b) => {
      if (a.surface !== b.surface) return a.surface ? -1 : 1; // rescue would-be-zeros first
      return b.r - a.r; // then largest-remainder
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

/** Duration as decimal hours, e.g. 30000s → "8.33h" (for the timesheet). */
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
