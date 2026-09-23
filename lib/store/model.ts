// Standalone store data model and its serialization to client shapes.
//
// A workspace is served to the client as a project: entries carry the
// workspace's numeric id in TimeEntry.project_id, so selectedProjects,
// codeMappings and everything downstream work unchanged.

import type { Db, ObjectId } from 'mongodb';
import type { TimeEntry } from '@/lib/calc';
import {
  DEFAULT_WEEKLY_HOURS,
  DEFAULT_BILLING_TAG_PREFIX,
  DEFAULT_ROUNDING_HOURS,
  DEFAULT_TIME_OFF_TAG,
} from '@/lib/calc';
// Type-only, so the server bundle does not pull in the client component.
import type { PresetValue } from '@/components/SettingsPanel';
import { EMPTY_EXPORT_FIELDS } from '@/lib/exportFields';

export interface WorkspaceDoc {
  _id?: ObjectId;
  numericId: number; // small, stable; allocated from the counters collection
  name: string;
  color?: string; // hex, like Toggl project colors
  settings: PresetValue; // same shape as localStorage presets
  createdAt: Date;
}

export interface EntryDoc {
  _id?: ObjectId;
  numericId: number; // exposed as TimeEntry.id
  workspaceId: number; // → workspaces.numericId
  description: string;
  start: Date; // UTC
  stop: Date | null; // null = running
  tags: string[]; // includes the billing tag, as in Toggl
  togglId?: number; // set by the importer; makes re-runs idempotent
  createdAt: Date;
  updatedAt: Date;
}

/** Allocate the next small numeric id for a collection (atomic $inc upsert). */
export async function nextSeq(db: Db, key: 'workspaces' | 'entries'): Promise<number> {
  return nextSeqBlock(db, key, 1);
}

/** Allocate `count` consecutive ids in one atomic bump; returns the first. */
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
 * An entry in the shape lib/calc.ts consumes. A running entry uses the Toggl
 * convention (stop: null, duration = -unixStart).
 */
export function toTimeEntry(e: EntryDoc): TimeEntry {
  return {
    id: e.numericId,
    start: e.start.toISOString(),
    stop: e.stop ? e.stop.toISOString() : null,
    duration: e.stop
      ? Math.round((e.stop.getTime() - e.start.getTime()) / 1000)
      : -Math.floor(e.start.getTime() / 1000),
    project_id: e.workspaceId, // workspace served as a project
    workspace_id: 1, // constant; unused downstream
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

// Default colors for new workspaces, cycled by numericId. Editable in Settings.
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
    billByProject: false,
    stripCodeParens: false,
    timeOffTag: DEFAULT_TIME_OFF_TAG,
    roundingHours: DEFAULT_ROUNDING_HOURS,
    startWindowHours: null,
    maxDescriptionLength: null,
    noOvertime: false,
    codeMappings: [],
    timesheetMode: 'summary',
    exportName: '',
    // Empty rather than inherited, so no other client's details carry over.
    exportFields: { ...EMPTY_EXPORT_FIELDS },
  };
}
