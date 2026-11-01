// Pure helpers behind the time-entry tools: resolving projects and tags,
// validating a batch before anything is written, and the compact shapes the
// tools return. No I/O, so scripts/check-mcp.ts can test them.

import type { TimeEntry } from '@/lib/calc';
import type { TogglAccount, TogglProject } from '@/lib/toggl/server';
import { isoSecond, type EntryFields } from '@/lib/mirror/model';
import { fmtClock, fmtDate, fmtLocal, hours, parseInstant, weekStartOf } from './time';

/** Longest single entry the tools accept. Longer is almost always a typo. */
export const MAX_ENTRY_SECONDS = 16 * 3600;
/** Shortest entry: anything less is noise, and the timesheet would not show it. */
const MIN_ENTRY_MS = 60_000;

/**
 * [startMs, stopMs) minus the blocks: the free stretches, each at least a
 * minute long. An entry that encloses a block splits around it.
 */
export function freeSegments(
  startMs: number,
  stopMs: number,
  blocks: { startMs: number; endMs: number }[]
): { startMs: number; stopMs: number }[] {
  let segments = [{ startMs, stopMs }];
  for (const b of blocks) {
    segments = segments.flatMap((seg) => {
      if (b.endMs <= seg.startMs || b.startMs >= seg.stopMs) return [seg];
      return [
        { startMs: seg.startMs, stopMs: Math.min(seg.stopMs, b.startMs) },
        { startMs: Math.max(seg.startMs, b.endMs), stopMs: seg.stopMs },
      ];
    });
  }
  return segments.filter((seg) => seg.stopMs - seg.startMs >= MIN_ENTRY_MS);
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export type Resolved<T> = { ok: true; value: T } | { ok: false; error: string };

const lc = (s: string) => s.trim().toLowerCase();

/** A project by id or name (exact, then case-insensitive). Archived projects are refused. */
export function resolveProject(account: TogglAccount, input: string | number): Resolved<TogglProject> {
  const asId = typeof input === 'number' ? input : /^\d+$/.test(input.trim()) ? Number(input) : null;
  let match: TogglProject[] = [];
  if (asId !== null) match = account.projects.filter((p) => p.id === asId);
  if (match.length === 0 && typeof input === 'string') {
    match = account.projects.filter((p) => p.name === input.trim());
    if (match.length === 0) match = account.projects.filter((p) => lc(p.name) === lc(input));
  }
  if (match.length === 0) return { ok: false, error: `Unknown project "${input}".` };
  if (match.length > 1) {
    return { ok: false, error: `"${input}" matches several projects; use its id (${match.map((p) => p.id).join(', ')}).` };
  }
  if (!match[0].active) return { ok: false, error: `Project "${match[0].name}" is archived.` };
  return { ok: true, value: match[0] };
}

/**
 * A tag's canonical name: exact, case-insensitive, or the one tag whose first
 * word is the input ("D-123" finds "D-123 Phase 2"). Null when unknown.
 */
export function resolveTag(account: TogglAccount, input: string): Resolved<string> {
  const v = input.trim();
  if (!v) return { ok: false, error: 'Empty tag.' };
  const exact = account.tags.find((t) => t.name === v);
  if (exact) return { ok: true, value: exact.name };
  const ci = account.tags.filter((t) => lc(t.name) === lc(v));
  if (ci.length === 1) return { ok: true, value: ci[0].name };
  const word = account.tags.filter((t) => t.name.split(/\s+/)[0] === v);
  if (word.length === 1) return { ok: true, value: word[0].name };
  if (word.length > 1) {
    return { ok: false, error: `Tag "${v}" is ambiguous: ${word.map((t) => `"${t.name}"`).join(', ')}.` };
  }
  return { ok: false, error: `Unknown tag "${v}".` };
}

/** Tags in a list: resolved names, or the new ones passed through when allowed. */
export function resolveTags(
  account: TogglAccount,
  inputs: string[],
  allowNew: boolean
): { tags: string[]; created: string[]; errors: string[] } {
  const tags: string[] = [];
  const created: string[] = [];
  const errors: string[] = [];
  for (const t of inputs) {
    const r = resolveTag(account, t);
    if (r.ok) {
      if (!tags.includes(r.value)) tags.push(r.value);
    } else if (allowNew && r.error.startsWith('Unknown tag')) {
      const name = t.trim();
      if (!tags.includes(name)) tags.push(name);
      created.push(name);
    } else {
      errors.push(r.error);
    }
  }
  return { tags, created, errors };
}

// ─── Read shapes ────────────────────────────────────────────────────────────

export interface Span {
  startMs: number;
  endMs: number;
  running: boolean;
}

export function spanOf(e: TimeEntry, nowMs: number): Span {
  const startMs = Date.parse(e.start);
  const running = e.duration < 0 || !e.stop;
  const endMs = running ? nowMs : e.stop ? Date.parse(e.stop) : startMs + e.duration * 1000;
  return { startMs, endMs: Math.max(startMs, endMs), running };
}

export interface CompactEntry {
  id: number;
  date: string;
  start: string; // HH:MM local
  stop: string | null; // HH:MM local; null while running
  hours: number;
  project: string | null;
  project_id: number | null;
  description: string;
  tags: string[];
  running?: true;
}

export function compactEntry(e: TimeEntry, account: TogglAccount, nowMs: number): CompactEntry {
  const s = spanOf(e, nowMs);
  const project = e.project_id ? account.projects.find((p) => p.id === e.project_id) : undefined;
  return {
    id: e.id,
    date: fmtDate(s.startMs),
    start: fmtClock(s.startMs),
    stop: s.running ? null : fmtClock(s.endMs),
    hours: hours((s.endMs - s.startMs) / 1000),
    project: project?.name ?? (e.project_id ? `#${e.project_id}` : null),
    project_id: e.project_id ?? null,
    description: e.description ?? '',
    tags: e.tags ?? [],
    ...(s.running ? { running: true as const } : {}),
  };
}

/** Hours per day and per Sat–Fri week, as the dashboard counts them. */
export function totals(entries: TimeEntry[], nowMs: number) {
  const day = new Map<string, number>();
  const week = new Map<string, number>();
  for (const e of entries) {
    const s = spanOf(e, nowMs);
    const secs = (s.endMs - s.startMs) / 1000;
    const d = fmtDate(s.startMs);
    day.set(d, (day.get(d) ?? 0) + secs);
    const w = fmtDate(weekStartOf(s.startMs));
    week.set(w, (week.get(w) ?? 0) + secs);
  }
  return {
    days: [...day].sort(([a], [b]) => a.localeCompare(b)).map(([date, s]) => ({ date, hours: hours(s) })),
    weeks: [...week]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([saturday, s]) => ({ week_starting_saturday: saturday, hours: hours(s) })),
  };
}

// ─── Write planning ─────────────────────────────────────────────────────────

export interface EntryInput {
  start: string;
  stop?: string;
  duration_minutes?: number;
  description: string;
  project: string | number;
  tags?: string[];
  billable?: boolean;
}

export interface PlannedEntry {
  index: number;
  /** The entry as the mirror stores it. */
  write: EntryFields & { stop: string };
  /** The same entry already in Toggl (same start minute, project and description). */
  duplicateOf: number | null;
  /** The same entry earlier in this batch (its index); only that one is created. */
  repeatOf: number | null;
  /** Existing entries (and earlier batch items, as "#n") it overlaps. */
  overlaps: string[];
  newTags: string[];
  summary: string;
}

const minuteOf = (ms: number) => Math.floor(ms / 60000);
const sameText = (a: string | undefined, b: string | undefined) => (a ?? '').trim() === (b ?? '').trim();

/** Start, stop and duration from either `stop` or `duration_minutes`. */
export function resolveTimes(
  start: string,
  stop: string | undefined,
  durationMinutes: number | undefined
): Resolved<{ startMs: number; stopMs: number }> {
  const startMs = parseInstant(start);
  if (startMs === null) {
    return { ok: false, error: `start "${start}" is not a time (local "YYYY-MM-DDTHH:MM" or ISO with offset).` };
  }
  if ((stop === undefined) === (durationMinutes === undefined)) {
    return { ok: false, error: 'Give exactly one of stop or duration_minutes.' };
  }
  let stopMs: number;
  if (stop !== undefined) {
    const parsed = parseInstant(stop);
    if (parsed === null) return { ok: false, error: `stop "${stop}" is not a time.` };
    stopMs = parsed;
  } else {
    stopMs = startMs + Math.round(durationMinutes! * 60) * 1000;
  }
  if (stopMs <= startMs) return { ok: false, error: 'stop must be after start.' };
  if (stopMs - startMs < MIN_ENTRY_MS) return { ok: false, error: 'Shorter than a minute.' };
  if (stopMs - startMs > MAX_ENTRY_SECONDS * 1000) {
    return { ok: false, error: `Longer than ${MAX_ENTRY_SECONDS / 3600}h; split it.` };
  }
  return { ok: true, value: { startMs, stopMs } };
}

/**
 * Validate a batch against the account and the entries already in Toggl.
 * Nothing is written unless `errors` is empty.
 */
export function planEntries(
  inputs: EntryInput[],
  account: TogglAccount,
  existing: TimeEntry[],
  opts: {
    allowNewTags: boolean;
    nowMs: number;
    /** Trim new entries so they never overlap existing entries of these projects. */
    avoidProjectIds?: number[];
  }
): { planned: PlannedEntry[]; errors: string[]; trimmed: { index: number; from: string; to: string }[]; skippedInside: { index: number; entry: string }[] } {
  const errors: string[] = [];
  const planned: PlannedEntry[] = [];
  const trimmed: { index: number; from: string; to: string }[] = [];
  const skippedInside: { index: number; entry: string }[] = [];
  const spans = existing.map((e) => ({ e, ...spanOf(e, opts.nowMs) }));
  const avoid = new Set(opts.avoidProjectIds ?? []);
  const blocks = spans.filter((s) => s.e.project_id !== null && avoid.has(s.e.project_id));

  inputs.forEach((input, index) => {
    const at = `#${index}`;
    const times = resolveTimes(input.start, input.stop, input.duration_minutes);
    const project = resolveProject(account, input.project);
    const tags = resolveTags(account, input.tags ?? [], opts.allowNewTags);
    const problems = [
      ...(times.ok ? [] : [times.error]),
      ...(project.ok ? [] : [project.error]),
      ...tags.errors,
    ];
    if (!input.description.trim()) problems.push('Empty description.');
    if (problems.length > 0 || !times.ok || !project.ok) {
      errors.push(`${at}: ${problems.join(' ')}`);
      return;
    }
    // Avoided entries are time already taken: the new entry keeps only the
    // free stretches around them, split where one sits inside it. Toggl's
    // seconds make sub-minute overlaps common, hence the minute minimum.
    const original = times.value;
    const segments = freeSegments(original.startMs, original.stopMs, blocks);
    if (segments.length === 0) {
      skippedInside.push({ index, entry: `${input.start} ${input.description.trim()}` });
      return;
    }
    if (segments.length > 1 || segments[0].startMs !== original.startMs || segments[0].stopMs !== original.stopMs) {
      trimmed.push({
        index,
        from: `${fmtLocal(original.startMs)}–${fmtClock(original.stopMs)}`,
        to: segments.map((seg) => `${fmtLocal(seg.startMs)}–${fmtClock(seg.stopMs)}`).join(', '),
      });
    }
    for (const { startMs, stopMs } of segments) {
      const write = {
        description: input.description.trim(),
        project_id: project.value.id,
        tags: tags.tags,
        start: isoSecond(startMs),
        stop: isoSecond(stopMs),
        duration: Math.round((Math.floor(stopMs / 1000) * 1000 - Math.floor(startMs / 1000) * 1000) / 1000),
        billable: input.billable ?? false,
      };
      const duplicate = spans.find(
        (sp) =>
          minuteOf(sp.startMs) === minuteOf(startMs) &&
          sp.e.project_id === project.value.id &&
          sameText(sp.e.description, write.description)
      );
      const live = planned.filter((p) => p.duplicateOf === null && p.repeatOf === null);
      const repeat = duplicate
        ? undefined
        : live.find(
            (p) =>
              minuteOf(Date.parse(p.write.start)) === minuteOf(startMs) &&
              p.write.project_id === project.value.id &&
              sameText(p.write.description, write.description)
          );
      const overlaps = [
        ...spans
          .filter((sp) => sp.e !== duplicate?.e && sp.startMs < stopMs && sp.endMs > startMs)
          .map((sp) => String(sp.e.id)),
        // Batch items skipped as duplicates are already counted as existing entries.
        ...live
          .filter((p) => p !== repeat)
          .filter((p) => Date.parse(p.write.start) < stopMs && Date.parse(p.write.stop) > startMs)
          .map((p) => `#${p.index}`),
      ];
      planned.push({
        index,
        write,
        duplicateOf: duplicate ? duplicate.e.id : null,
        repeatOf: repeat ? repeat.index : null,
        overlaps,
        newTags: tags.created,
        summary: `${fmtLocal(startMs)}–${fmtClock(stopMs)} ${project.value.name}: ${write.description}${
          write.tags.length ? ` [${write.tags.join(', ')}]` : ''
        }`,
      });
    }
  });

  return { planned, errors, trimmed, skippedInside };
}

/** The local-midnight window that covers every planned entry, padded a day each side. */
export function coveringWindow(planned: { write: EntryFields & { stop: string } }[]): { startISO: string; endISO: string } | null {
  if (planned.length === 0) return null;
  const starts = planned.map((p) => Date.parse(p.write.start));
  const stops = planned.map((p) => Date.parse(p.write.stop));
  const a = new Date(Math.min(...starts));
  a.setHours(0, 0, 0, 0);
  a.setDate(a.getDate() - 1);
  const b = new Date(Math.max(...stops));
  b.setHours(0, 0, 0, 0);
  b.setDate(b.getDate() + 2);
  return { startISO: a.toISOString(), endISO: b.toISOString() };
}
