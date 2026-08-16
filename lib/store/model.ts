// Data model of the standalone store and its serialization to the shapes the
// client already speaks.
//
// The one design move that keeps the rest of the app untouched: a WORKSPACE is
// served to the client as a "project" — entries carry the workspace's numeric
// id in the TimeEntry.project_id slot, so ProjectSet / selectedProjects /
// codeMappings (and everything downstream of them) work unchanged.

import type { Db, ObjectId } from 'mongodb';
import type { TimeEntry } from '@/lib/calc';
import {
  DEFAULT_WEEKLY_HOURS,
  DEFAULT_BILLING_TAG_PREFIX,
  DEFAULT_ROUNDING_HOURS,
  DEFAULT_TIME_OFF_TAG,
} from '@/lib/calc';
// Type-only import from a client module — erased at compile time, so the
// server bundle never pulls the component in.
import type { PresetValue } from '@/components/SettingsPanel';
import { EMPTY_EXPORT_FIELDS } from '@/lib/exportFields';

export interface WorkspaceDoc {
  _id?: ObjectId;
  numericId: number; // small, stable; allocated from the counters collection
  name: string;
  color?: string; // hex, shown in chips exactly like Toggl project colors
  settings: PresetValue; // the same shape localStorage presets snapshot
  createdAt: Date;
}

export interface EntryDoc {
  _id?: ObjectId;
  numericId: number; // TimeEntry.id is a number
  workspaceId: number; // → workspaces.numericId
  description: string;
  start: Date; // UTC
  stop: Date | null; // null = running
  tags: string[]; // billing tag included here, same as Toggl
  togglId?: number; // set by the importer; enables idempotent re-runs
  createdAt: Date;
  updatedAt: Date;
}

/** Allocate the next small numeric id for a collection (atomic $inc upsert). */
export async function nextSeq(db: Db, key: 'workspaces' | 'entries'): Promise<number> {
  return nextSeqBlock(db, key, 1);
}

/**
 * Allocate `count` consecutive numeric ids in one atomic bump (the importer
 * inserts whole windows at once); returns the FIRST id of the block.
 */
export async function nextSeqBlock(
  db: Db,
  key: 'workspaces' | 'entries',
  count: number
): Promise<number> {
  const res = await db
    .collection<{ _id: string; seq: number }>('counters')
    .findOneAndUpdate(
      { _id: key },
      { $inc: { seq: count } },
      { upsert: true, returnDocument: 'after' }
    );
  return res!.seq - count + 1;
}

/**
 * An entry in the exact shape lib/calc.ts consumes. A running entry follows the
 * Toggl convention (stop: null, duration = -unixStart) that normalize() already
 * treats as "running, clamp to now" — the live ring needs no special handling.
 */
export function toTimeEntry(e: EntryDoc): TimeEntry {
  return {
    id: e.numericId,
    start: e.start.toISOString(),
    stop: e.stop ? e.stop.toISOString() : null,
    duration: e.stop
      ? Math.round((e.stop.getTime() - e.start.getTime()) / 1000)
      : -Math.floor(e.start.getTime() / 1000),
    project_id: e.workspaceId, // ← the workspace-is-a-project trick
    workspace_id: 1, // constant; nothing reads it downstream
    description: e.description,
    tags: e.tags,
  };
}

/** The workspace shape served to the client (numericId exposed as `id`). */
export interface StoreWorkspace {
  id: number;
  name: string;
  color?: string;
  settings: PresetValue;
  createdAt: string;
}

export function toStoreWorkspace(w: WorkspaceDoc): StoreWorkspace {
  return {
    id: w.numericId,
    name: w.name,
    color: w.color,
    settings: w.settings,
    createdAt: w.createdAt.toISOString(),
  };
}

// Toggl-ish palette new workspaces cycle through (by numericId), so chips are
// distinguishable out of the box; the color stays editable in Settings.
export const WORKSPACE_COLORS = [
  '#0b83d9',
  '#9e5bd9',
  '#d94182',
  '#e36a00',
  '#2da608',
  '#06a893',
  '#c9806b',
  '#465bb3',
  '#bf7000',
  '#990099',
  '#c7af14',
  '#d92b2b',
] as const;

export function autoColor(numericId: number): string {
  return WORKSPACE_COLORS[(numericId - 1 + WORKSPACE_COLORS.length * 1000) % WORKSPACE_COLORS.length];
}

/** True for a #rrggbb color the chips can render. */
export function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim());
}

/**
 * Baseline settings for a workspace created without a snapshot. Mirrors the
 * client-side DEFAULTS (lib/useTrackSource) minus the non-preset fields.
 */
export function defaultWorkspaceSettings(): PresetValue {
  return {
    selectedProjects: [],
    groupName: '',
    shortFriday: false,
    weeklyHours: DEFAULT_WEEKLY_HOURS,
    maxBillableHours: null,
    minWorkingDayHours: null,
    billingTagPrefix: DEFAULT_BILLING_TAG_PREFIX,
    stripCodeParens: false,
    timeOffTag: DEFAULT_TIME_OFF_TAG,
    roundingHours: DEFAULT_ROUNDING_HOURS,
    maxDescriptionLength: null,
    noOvertime: false,
    codeMappings: [],
    timesheetMode: 'summary',
    exportName: '',
    // A workspace created without a snapshot (e.g. one per Toggl project on the
    // import page) starts with export details of its own rather than inheriting
    // another client's: the first export fills them in, and they stay here.
    exportFields: { ...EMPTY_EXPORT_FIELDS },
  };
}
