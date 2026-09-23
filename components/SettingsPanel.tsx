'use client';

import { useEffect, useRef, useState } from 'react';
import type { SourceMode, TrackProject } from '@/lib/source/types';
import {
  DEFAULT_WEEKLY_HOURS,
  DEFAULT_BILLING_TAG_PREFIX,
  DEFAULT_ROUNDING_HOURS,
  DEFAULT_TIME_OFF_TAG,
  ROUNDING_HOURS_OPTIONS,
  START_WINDOW_HOURS_OPTIONS,
  defaultMaxBillableHours,
  defaultMinWorkingDayHours,
  fmtHoursLabel,
} from '@/lib/calc';
import { mappingGridCompatible, type CodeMapping } from '@/lib/timesheet/mapping';
import { EMPTY_EXPORT_FIELDS, type ExportFieldValues } from '@/lib/exportFields';
import InstallAppBlock from '@/components/InstallAppBlock';

export type TimesheetMode = 'summary' | 'individual';

/**
 * A tracked project. Name and color are copied from the project list so chips
 * and timesheet prefixes render without a fresh fetch.
 */
export interface SelectedProject {
  id: number;
  name: string;
  color?: string;
}

export interface SettingsValue {
  token: string;
  // One or more projects that together count as "the project".
  selectedProjects: SelectedProject[];
  // Title when several projects are selected; blank shows initials chips.
  groupName: string;
  shortFriday: boolean;
  // Weekly target in hours (default 40). Scales every other target.
  weeklyHours: number;
  // null = scale with weeklyHours; a number = fixed hours.
  maxBillableHours: number | null;
  minWorkingDayHours: number | null;
  // Prefix that marks a tag as a billing tag (default "D", as in "D123").
  billingTagPrefix: string;
  // Bill every entry to its project and ignore the billing-code layer (prefix,
  // ticket brackets, "(X)"/"(!)" markers, parentheses strip, linked codes).
  billByProject: boolean;
  // Drop parenthetical groups from codes ("D123 (Phase 2)" → "D123"). The
  // "(X)"/"(!)" markers are read before the strip, so they keep working.
  stripCodeParens: boolean;
  // Tag that marks a day as time off (default ".Time Off"). The day counts
  // like a weekend and the marker entry is never billed, counted or exported.
  timeOffTag: string;
  // Rounding unit in hours: 0.25 (default), 0.2, 0.5 or 1.
  roundingHours: number;
  // Grid the Individual view anchors start times to, in hours. null = same as
  // roundingHours. A coarser window serves clients that take quarter-hour
  // durations but only accept starts on :00/:30.
  startWindowHours: number | null;
  // Character cap on merged descriptions; null = no limit (see
  // lib/timesheet/desc).
  maxDescriptionLength: number | null;
  // Cap each week's billed total at weeklyHours; the excess goes on an
  // "Overtime" line. "(X)" codes are trimmed first.
  noOvertime: boolean;
  // Projects that carry another client's billing tags (own prefix and grid)
  // and bill here as one fixed code per day (see lib/timesheet/mapping).
  codeMappings: CodeMapping[];
  refreshSec: number;
  timesheetMode: TimesheetMode;
  // Name in the PDF header. Blank falls back to the Toggl account name.
  exportName: string;
  // The export dialog's identity fields (lib/exportFields). Edited in the
  // dialog, but stored here so each workspace snapshot keeps its own.
  exportFields: ExportFieldValues;
}

/**
 * What a stored workspace captures: all settings except the token (shared
 * across workspaces) and the refresh interval (per device).
 */
export type PresetValue = Omit<SettingsValue, 'token' | 'refreshSec'>;

export interface SettingsPreset {
  id: string;
  name: string;
  value: PresetValue;
  // Standalone mode only: chip color, assigned by the server, editable here.
  color?: string;
}

export function toPresetValue(s: SettingsValue): PresetValue {
  return {
    selectedProjects: s.selectedProjects,
    groupName: s.groupName,
    shortFriday: s.shortFriday,
    weeklyHours: s.weeklyHours,
    maxBillableHours: s.maxBillableHours,
    minWorkingDayHours: s.minWorkingDayHours,
    billingTagPrefix: s.billingTagPrefix,
    billByProject: s.billByProject,
    stripCodeParens: s.stripCodeParens,
    timeOffTag: s.timeOffTag,
    roundingHours: s.roundingHours,
    startWindowHours: s.startWindowHours,
    maxDescriptionLength: s.maxDescriptionLength,
    noOvertime: s.noOvertime,
    codeMappings: s.codeMappings,
    timesheetMode: s.timesheetMode,
    exportName: s.exportName,
    exportFields: s.exportFields ?? EMPTY_EXPORT_FIELDS,
  };
}

/**
 * Whether a settings value matches a stored workspace. Projects compare by id
 * only, since names and colors can change in Toggl. Export fields are not
 * compared: the export dialog writes them into the active workspace, so they
 * must not make it stop reading as active.
 */
export function presetMatches(value: PresetValue, s: SettingsValue): boolean {
  const ids = (ps: SelectedProject[]) =>
    ps
      .map((p) => p.id)
      .sort((a, b) => a - b)
      .join(',');
  // Order-insensitive. The `??` fallbacks here and below cover presets stored
  // before a field existed.
  const maps = (ms: CodeMapping[] | undefined) =>
    (ms ?? [])
      .map(
        (m) =>
          `${m.projectId}|${m.tagPrefix}|${m.roundingHours}|${m.targetCode}|` +
          `${m.noOvertime ? m.weeklyHours ?? DEFAULT_WEEKLY_HOURS : ''}`
      )
      .sort()
      .join(';');
  return (
    ids(value.selectedProjects) === ids(s.selectedProjects) &&
    value.groupName === s.groupName &&
    value.shortFriday === s.shortFriday &&
    value.weeklyHours === s.weeklyHours &&
    value.maxBillableHours === s.maxBillableHours &&
    value.minWorkingDayHours === s.minWorkingDayHours &&
    value.billingTagPrefix === s.billingTagPrefix &&
    (value.billByProject ?? false) === (s.billByProject ?? false) &&
    (value.stripCodeParens ?? false) === (s.stripCodeParens ?? false) &&
    (value.timeOffTag ?? DEFAULT_TIME_OFF_TAG) === (s.timeOffTag ?? DEFAULT_TIME_OFF_TAG) &&
    value.roundingHours === s.roundingHours &&
    (value.startWindowHours ?? null) === (s.startWindowHours ?? null) &&
    (value.maxDescriptionLength ?? null) === (s.maxDescriptionLength ?? null) &&
    value.noOvertime === s.noOvertime &&
    maps(value.codeMappings) === maps(s.codeMappings) &&
    value.timesheetMode === s.timesheetMode &&
    value.exportName === s.exportName
  );
}

function genPresetId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const WEEKLY_MIN = 1;
const WEEKLY_MAX = 80;
const STEP = 0.25; // hours fields use 15-minute steps

function clampQuarter(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n / STEP) * STEP));
}

/** 4 → "4", 2.5 → "2.5" (no "h"). */
function numLabel(n: number): string {
  return String(Number(n.toFixed(2)));
}

// Empty or unparseable = no limit. Minimum 5 leaves room for the "; …" marker.
const MAX_DESC_LEN_MIN = 5;
function parseMaxDescLen(s: string): number | null {
  const n = parseInt(s, 10);
  if (s.trim() === '' || !Number.isFinite(n)) return null;
  return Math.max(MAX_DESC_LEN_MIN, n);
}

// "1 hour", or "15 minutes (0.25h)".
function roundingLabel(hours: number): string {
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours * 60)} minutes (${numLabel(hours)}h)`;
}

// ":00, :15, :30, :45". Every offered unit divides an hour evenly.
function gridMarks(hours: number): string {
  const mins = Math.round(hours * 60);
  const marks: string[] = [];
  for (let m = 0; m < 60; m += mins) marks.push(`:${String(m).padStart(2, '0')}`);
  return marks.join(', ');
}

// "Every 30 minutes (:00, :30)".
function startWindowLabel(hours: number): string {
  const mins = Math.round(hours * 60);
  return `${mins === 60 ? 'Every hour' : `Every ${mins} minutes`} (${gridMarks(hours)})`;
}

// "1-hour" or "15-min", for inline prose.
function gridLabel(hours: number): string {
  if (Number.isInteger(hours)) return `${hours}-hour`;
  return `${Math.round(hours * 60)}-min`;
}

// Labels show the requests/hour each costs (Toggl Free allows 30/hour).
const REFRESH_OPTIONS = [
  { sec: 60, label: '1 min — ~60/hr (paid plans only)' },
  { sec: 120, label: '2 min — ~30/hr (at the Free limit)' },
  { sec: 180, label: '3 min — ~20/hr (recommended)' },
  { sec: 300, label: '5 min — ~12/hr (conservative)' },
  { sec: 600, label: '10 min — ~6/hr' },
];

function fmtInterval(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} min` : `${sec}s`;
}

export default function SettingsPanel({
  initial,
  projects,
  projectsLoaded,
  serverManaged,
  mode = 'toggl',
  cacheInterval,
  authError,
  connecting,
  presets,
  onPresetsChange,
  onApply,
  onConnect,
  onSave,
  onClose,
  canClose,
  activeWorkspaceId,
  activePresetId,
  openWorkspaces = false,
  onWorkspaceCreate,
  onWorkspaceRecapture,
  onWorkspaceRename,
  onWorkspaceDelete,
  onWorkspaceColor,
  sync,
  syncNotice,
  onSyncResolve,
  onSyncPassword,
  syncPwBusy,
  syncPwError,
  onExportFile,
  onImportFile,
}: {
  initial: SettingsValue;
  projects: TrackProject[];
  // The project list has been fetched. Tells "loading" apart from "empty"
  // (e.g. every project archived), which must still show archived rows.
  projectsLoaded: boolean;
  serverManaged: boolean;
  // In standalone mode the "projects" are stored workspaces, the token and
  // refresh UI are hidden, and the Workspaces section uses onWorkspace*.
  mode?: SourceMode;
  // Server cache interval in seconds. When set, the refresh picker is hidden.
  cacheInterval: number | null;
  authError: string | null;
  connecting: boolean;
  // Stored workspaces. Edits persist at once, independent of Save. In
  // standalone mode these are the server's workspaces and onPresetsChange is
  // unused.
  presets: SettingsPreset[];
  onPresetsChange: (presets: SettingsPreset[]) => void;
  // Switch to a workspace and persist it immediately.
  onApply: (preset: SettingsPreset) => void;
  onConnect: (token: string) => void;
  onSave: (value: SettingsValue) => void;
  onClose: () => void;
  canClose: boolean;
  // Standalone mode: the active workspace, excluded from the linked-codes
  // picker (it can't link onto its own timesheet).
  activeWorkspaceId?: number | null;
  // The active workspace by id. Needed when two workspaces differ only in
  // export details. Undefined falls back to presetMatches.
  activePresetId?: string | null;
  // Opened from the topbar's "Manage workspaces…": expand that section and
  // scroll to it.
  openWorkspaces?: boolean;
  // Standalone-mode workspace CRUD. Create resolves the new workspace, or null
  // on failure. Delete resolves false when the user cancelled a confirm.
  onWorkspaceCreate?: (name: string, settings: PresetValue) => Promise<SettingsPreset | null>;
  onWorkspaceRecapture?: (id: string, settings: PresetValue) => void;
  onWorkspaceRename?: (id: string, name: string) => void;
  onWorkspaceDelete?: (id: string) => Promise<boolean>;
  onWorkspaceColor?: (id: string, color: string) => void;
  // ---- "Sync & transfer" section, mirrored from useTrackSource().sync ----
  sync?: {
    enabled: boolean;
    misconfigured: string | null;
    needsAuth: boolean;
    status: 'idle' | 'syncing' | 'error';
    error: string | null;
    lastSyncedAt: number | null;
    conflict: { rev: number; updatedAt: string; device: string } | null;
  } | null;
  // Success message from the wiring; outlives the remount after an import.
  syncNotice?: string | null;
  onSyncResolve?: (choice: 'remote' | 'local') => void;
  // Password form (browser-token mode has no page-level gate).
  onSyncPassword?: (password: string) => void;
  syncPwBusy?: boolean;
  syncPwError?: string | null;
  onExportFile?: () => void;
  onImportFile?: (file: File) => Promise<string | null>;
}) {
  const [token, setToken] = useState(initial.token);
  const [selectedIds, setSelectedIds] = useState<number[]>(
    initial.selectedProjects.map((p) => p.id)
  );
  const [groupName, setGroupName] = useState(initial.groupName);
  const [multiExpanded, setMultiExpanded] = useState(initial.selectedProjects.length > 1);
  const [shortFriday, setShortFriday] = useState(initial.shortFriday);
  const [refreshSec, setRefreshSec] = useState(initial.refreshSec);
  const [timesheetMode, setTimesheetMode] = useState<TimesheetMode>(initial.timesheetMode);
  const [exportName, setExportName] = useState(initial.exportName);

  // Hours fields stay raw strings so a half-typed "3." doesn't snap; they are
  // parsed and clamped on save. An empty override means null (auto).
  const [weeklyStr, setWeeklyStr] = useState(numLabel(initial.weeklyHours));
  const [maxBillStr, setMaxBillStr] = useState(
    initial.maxBillableHours === null ? '' : numLabel(initial.maxBillableHours)
  );
  const [minDayStr, setMinDayStr] = useState(
    initial.minWorkingDayHours === null ? '' : numLabel(initial.minWorkingDayHours)
  );
  const [billingPrefix, setBillingPrefix] = useState(initial.billingTagPrefix);
  // `!!`, `??` and `== null` below cover settings stored before a field existed.
  const [billByProject, setBillByProject] = useState(!!initial.billByProject);
  const [stripCodeParens, setStripCodeParens] = useState(!!initial.stripCodeParens);
  const [timeOffTag, setTimeOffTag] = useState(initial.timeOffTag ?? DEFAULT_TIME_OFF_TAG);
  const [roundingHours, setRoundingHours] = useState(initial.roundingHours);
  const [startWindowHours, setStartWindowHours] = useState<number | null>(
    initial.startWindowHours ?? null
  );
  // Raw string like the hours fields; empty = no limit.
  const [maxDescLenStr, setMaxDescLenStr] = useState(
    initial.maxDescriptionLength == null ? '' : String(initial.maxDescriptionLength)
  );
  const [noOvertime, setNoOvertime] = useState(initial.noOvertime);
  const [codeMappings, setCodeMappings] = useState<CodeMapping[]>(initial.codeMappings ?? []);
  const [showAdvanced, setShowAdvanced] = useState(
    initial.maxBillableHours !== null ||
      initial.minWorkingDayHours !== null ||
      initial.billingTagPrefix !== DEFAULT_BILLING_TAG_PREFIX ||
      !!initial.billByProject ||
      !!initial.stripCodeParens ||
      (initial.timeOffTag ?? DEFAULT_TIME_OFF_TAG) !== DEFAULT_TIME_OFF_TAG ||
      initial.roundingHours !== DEFAULT_ROUNDING_HOURS ||
      initial.startWindowHours != null ||
      initial.maxDescriptionLength != null ||
      initial.noOvertime ||
      (initial.codeMappings?.length ?? 0) > 0 ||
      initial.exportName.trim() !== ''
  );

  const standalone = mode === 'standalone';
  const tokenConnected = projects.length > 0;

  // Selected projects missing from the fetched list (archived or deleted). They
  // keep a checklist row so they can be dropped; once unchecked they can't be
  // re-selected, so the row is disabled. Gated on projectsLoaded so a loading
  // list doesn't mark everything archived.
  const archivedSelected = projectsLoaded
    ? initial.selectedProjects.filter((sp) => !projects.some((p) => p.id === sp.id))
    : [];

  // Archived rows keep the picker visible even with an empty active list, or
  // they could never be unchecked.
  const showProjects = serverManaged || tokenConnected || archivedSelected.length > 0;
  // In standalone mode stored workspaces fill the "project" slot.
  const itemNoun = standalone ? 'workspace' : 'project';

  // Stays open while editing even at one selection, or a second could never be
  // picked. Reopening Settings with one project saved shows the dropdown.
  const multiMode = multiExpanded || selectedIds.length > 1;

  const toggleProject = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // Clamped weekly value, used to preview the scaled defaults in placeholders.
  const parsedWeekly = parseFloat(weeklyStr);
  const previewWeekly = Number.isFinite(parsedWeekly)
    ? clampQuarter(parsedWeekly, WEEKLY_MIN, WEEKLY_MAX)
    : DEFAULT_WEEKLY_HOURS;

  // Only windows coarser than the rounding unit. One that stops qualifying
  // drops out of the list and, via buildValue, out of the saved value.
  const startWindowOptions = START_WINDOW_HOURS_OPTIONS.filter((h) => h > roundingHours);
  const selectedStartWindow =
    startWindowHours != null && startWindowHours > roundingHours ? startWindowHours : null;

  // Shared by Save and "store as a workspace", so both capture the same value.
  const buildValue = (): SettingsValue => {
    // Fall back to the stored entry for archived projects.
    const selectedProjects: SelectedProject[] = selectedIds.map((id) => {
      const proj = projects.find((p) => p.id === id);
      if (proj) return { id: proj.id, name: proj.name, color: proj.color };
      return initial.selectedProjects.find((p) => p.id === id) ?? { id, name: '' };
    });
    const weeklyHours = previewWeekly;
    // Empty or unparseable = null (auto); otherwise clamp to [min, weeklyHours].
    // The Friday floor may be 0 (no floor); the billable cap can't.
    const parseOverride = (s: string, min: number): number | null => {
      const n = parseFloat(s);
      if (s.trim() === '' || !Number.isFinite(n)) return null;
      return clampQuarter(n, min, weeklyHours);
    };
    const finalRounding = ROUNDING_HOURS_OPTIONS.includes(
      roundingHours as (typeof ROUNDING_HOURS_OPTIONS)[number]
    )
      ? roundingHours
      : DEFAULT_ROUNDING_HOURS;
    // Anything but an offered, strictly coarser window is stored as null.
    const finalStartWindow =
      startWindowHours != null &&
      START_WINDOW_HOURS_OPTIONS.includes(
        startWindowHours as (typeof START_WINDOW_HOURS_OPTIONS)[number]
      ) &&
      startWindowHours > finalRounding
        ? startWindowHours
        : null;
    // Keep complete rows on selected projects, one per project. An
    // incompatible grid falls back to this sheet's unit: the linked totals must
    // land on this sheet's grid to match the other sheet.
    const seenMapped = new Set<number>();
    const cleanedMappings: CodeMapping[] = [];
    for (const m of codeMappings) {
      const tagPrefix = m.tagPrefix.trim();
      const targetCode = m.targetCode.trim();
      if (!m.projectId || !tagPrefix || !targetCode) continue;
      if (!selectedIds.includes(m.projectId) || seenMapped.has(m.projectId)) continue;
      seenMapped.add(m.projectId);
      const validUnit =
        ROUNDING_HOURS_OPTIONS.includes(m.roundingHours as (typeof ROUNDING_HOURS_OPTIONS)[number]) &&
        mappingGridCompatible(m.roundingHours, finalRounding);
      cleanedMappings.push({
        projectId: m.projectId,
        tagPrefix,
        roundingHours: validUnit ? m.roundingHours : finalRounding,
        targetCode,
        noOvertime: !!m.noOvertime,
        weeklyHours: Number.isFinite(m.weeklyHours as number)
          ? clampQuarter(m.weeklyHours as number, WEEKLY_MIN, WEEKLY_MAX)
          : DEFAULT_WEEKLY_HOURS,
      });
    }
    return {
      // Empty so the proxy uses the server's TOGGL_API_TOKEN.
      token: serverManaged ? '' : token,
      selectedProjects,
      groupName: selectedProjects.length > 1 ? groupName.trim() : '',
      shortFriday,
      weeklyHours,
      maxBillableHours: parseOverride(maxBillStr, STEP),
      minWorkingDayHours: parseOverride(minDayStr, 0),
      // An empty prefix would match every tag, so fall back to the default.
      billingTagPrefix: billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX,
      // Code settings keep their values while hidden, so turning this off
      // restores them.
      billByProject,
      stripCodeParens,
      // An empty tag can't mark anything, so fall back to the default.
      timeOffTag: timeOffTag.trim() || DEFAULT_TIME_OFF_TAG,
      roundingHours: finalRounding,
      startWindowHours: finalStartWindow,
      maxDescriptionLength: parseMaxDescLen(maxDescLenStr),
      noOvertime,
      codeMappings: cleanedMappings,
      refreshSec,
      timesheetMode,
      exportName: exportName.trim(),
      // Owned by the export dialog. Read from the live prop so Save carries
      // whatever the dialog last wrote.
      exportFields: initial.exportFields ?? EMPTY_EXPORT_FIELDS,
    };
  };

  const handleSave = () => onSave(buildValue());

  // Export-dialog fields that have a value, listed read-only in the panel.
  const setExportFieldLabels = (
    [
      ['company', 'company'],
      ['client', 'client'],
      ['role', 'role'],
      ['approver', 'approver'],
      ['reference', 'reference'],
      ['rate', 'rate'],
      ['engagementEn', 'engagement note (English)'],
      ['engagementCs', 'engagement note (Czech)'],
    ] as [keyof ExportFieldValues, string][]
  )
    .filter(([key]) => (initial.exportFields?.[key] ?? '').trim() !== '')
    .map(([, label]) => label);

  // ---- Linked billing codes ----
  // Half-filled rows are fine while editing; buildValue drops them.
  //
  // Toggl mode targets the tracked projects. Standalone mode targets any other
  // workspace and adds it to the tracked set, since its entries must load with
  // this sheet's.
  const mappingCandidateIds = standalone
    ? projects.map((p) => p.id).filter((id) => id !== activeWorkspaceId)
    : selectedIds;
  const ensureSelected = (id: number) => {
    if (standalone && id) {
      setSelectedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
  };
  const updateMapping = (i: number, patch: Partial<CodeMapping>) => {
    if (patch.projectId) ensureSelected(patch.projectId);
    setCodeMappings((ms) => ms.map((m, idx) => (idx === i ? { ...m, ...patch } : m)));
  };
  const removeMapping = (i: number) =>
    setCodeMappings((ms) => ms.filter((_, idx) => idx !== i));
  const addMapping = () => {
    const free = mappingCandidateIds.find((id) => !codeMappings.some((m) => m.projectId === id));
    if (free) ensureSelected(free);
    setCodeMappings((ms) => [
      ...ms,
      // New rows start on this sheet's grid
      {
        projectId: free ?? 0,
        tagPrefix: '',
        roundingHours,
        targetCode: '',
        noOvertime: false,
        weeklyHours: DEFAULT_WEEKLY_HOURS,
      },
    ]);
  };
  const projectNameOf = (id: number) =>
    projects.find((p) => p.id === id)?.name ??
    initial.selectedProjects.find((p) => p.id === id)?.name ??
    `#${id}`;

  // ---- Sync & transfer ----
  // Starts open on a notice; a pending conflict forces it open below.
  const [syncOpen, setSyncOpen] = useState(!!syncNotice);
  const [syncPw, setSyncPw] = useState('');
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const handleImportFile = async (file: File) => {
    if (!onImportFile) return;
    const err = await onImportFile(file);
    // Success arrives as syncNotice after the remount; errors stay local.
    if (err) setImportMsg(err);
  };

  // ---- Workspaces (stored settings) ----
  // Starts open on a fresh standalone install (first task: create a workspace)
  // or when opened for this section.
  const [wsOpen, setWsOpen] = useState(openWorkspaces || (standalone && presets.length === 0));
  // The section is far down the form, so scroll to it too.
  const wsSectionRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!openWorkspaces) return;
    wsSectionRef.current?.scrollIntoView({ block: 'start' });
  }, [openWorkspaces]);
  const [newPresetName, setNewPresetName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  // Load a workspace into the form without saving (recallPreset also saves).
  const applyPresetToForm = (v: PresetValue) => {
    setSelectedIds(v.selectedProjects.map((p) => p.id));
    setGroupName(v.groupName);
    setMultiExpanded(v.selectedProjects.length > 1);
    setShortFriday(v.shortFriday);
    setTimesheetMode(v.timesheetMode);
    setExportName(v.exportName);
    setWeeklyStr(numLabel(v.weeklyHours));
    setMaxBillStr(v.maxBillableHours === null ? '' : numLabel(v.maxBillableHours));
    setMinDayStr(v.minWorkingDayHours === null ? '' : numLabel(v.minWorkingDayHours));
    setBillingPrefix(v.billingTagPrefix);
    // Fallbacks cover presets stored before a field existed.
    setBillByProject(!!v.billByProject);
    setStripCodeParens(!!v.stripCodeParens);
    setTimeOffTag(v.timeOffTag ?? DEFAULT_TIME_OFF_TAG);
    setRoundingHours(v.roundingHours);
    setStartWindowHours(v.startWindowHours ?? null);
    setMaxDescLenStr(v.maxDescriptionLength == null ? '' : String(v.maxDescriptionLength));
    setNoOvertime(v.noOvertime);
    setCodeMappings(v.codeMappings ?? []);
    if (
      v.maxBillableHours !== null ||
      v.minWorkingDayHours !== null ||
      v.billingTagPrefix !== DEFAULT_BILLING_TAG_PREFIX ||
      !!v.billByProject ||
      !!v.stripCodeParens ||
      (v.timeOffTag ?? DEFAULT_TIME_OFF_TAG) !== DEFAULT_TIME_OFF_TAG ||
      v.roundingHours !== DEFAULT_ROUNDING_HOURS ||
      v.startWindowHours != null ||
      v.maxDescriptionLength != null ||
      v.noOvertime ||
      (v.codeMappings?.length ?? 0) > 0 ||
      v.exportName.trim() !== ''
    ) {
      setShowAdvanced(true);
    }
  };

  // Standalone mode: server workspaces via onWorkspace*. Toggl mode: the
  // localStorage preset list.
  const addPreset = async () => {
    const name = newPresetName.trim();
    if (!name) return;
    if (standalone) {
      // The server copies the form's settings but points the new workspace's
      // selection at itself. The form then switches to it.
      const created = await onWorkspaceCreate?.(name, toPresetValue(buildValue()));
      if (!created) return;
      applyPresetToForm(created.value);
      setNewPresetName('');
      return;
    }
    if (selectedIds.length === 0) return;
    onPresetsChange([...presets, { id: genPresetId(), name, value: toPresetValue(buildValue()) }]);
    setNewPresetName('');
  };
  const updatePreset = (id: string) => {
    if (standalone) {
      onWorkspaceRecapture?.(id, toPresetValue(buildValue()));
      return;
    }
    onPresetsChange(
      presets.map((p) => (p.id === id ? { ...p, value: toPresetValue(buildValue()) } : p))
    );
  };
  const deletePreset = async (id: string) => {
    if (standalone) {
      const deleted = (await onWorkspaceDelete?.(id)) ?? false;
      if (deleted) {
        // Mirror the server: drop references to the deleted workspace.
        const numId = Number(id);
        setSelectedIds((prev) => prev.filter((x) => x !== numId));
        setCodeMappings((ms) => ms.filter((m) => m.projectId !== numId));
      }
    } else {
      onPresetsChange(presets.filter((p) => p.id !== id));
    }
    if (renamingId === id) setRenamingId(null);
  };
  const startRename = (p: SettingsPreset) => {
    setRenamingId(p.id);
    setRenameText(p.name);
  };
  const commitRename = () => {
    const name = renameText.trim();
    if (name) {
      if (standalone && renamingId !== null) {
        onWorkspaceRename?.(renamingId, name);
      } else {
        onPresetsChange(presets.map((p) => (p.id === renamingId ? { ...p, name } : p)));
      }
    }
    setRenamingId(null);
  };
  // Persist and load into the form, so Save/Cancel and the active marker agree.
  const recallPreset = (p: SettingsPreset) => {
    applyPresetToForm(p.value);
    onApply(p);
  };

  return (
    <div className="overlay">
      <div className="panel">
        <h2>Settings</h2>

        {standalone ? (
          <p className="hint">
            This deployment stores its own time entries, so there&apos;s no Toggl account to
            connect. Pick workspaces below and track time on the <strong>Tracker</strong> page. To
            bring over Toggl history, use <a href="/import">Import</a>.
          </p>
        ) : serverManaged ? (
          <p className="hint">
            The Toggl API token is set on the server. Pick your project below.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="token">Toggl Track API token</label>
              <input
                id="token"
                type="password"
                value={token}
                placeholder="Paste your API token"
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
              <p className="hint">
                Find it at{' '}
                <a href="https://track.toggl.com/profile" target="_blank" rel="noreferrer">
                  track.toggl.com/profile
                </a>{' '}
                (bottom of the page). It is stored only in this browser and sent only to this
                app&apos;s proxy.
              </p>
            </div>

            <div className="row" style={{ justifyContent: 'flex-start' }}>
              <button
                className="btn"
                onClick={() => onConnect(token)}
                disabled={!token || connecting}
              >
                {connecting ? 'Connecting…' : tokenConnected ? 'Reconnect' : 'Connect'}
              </button>
            </div>
          </>
        )}

        {authError && <div className="err-msg">{authError}</div>}

        {showProjects && (
          <div className="field">
            <label htmlFor="project">
              {standalone ? (multiMode ? 'Workspaces' : 'Workspace') : multiMode ? 'Projects' : 'Project'}
            </label>
            {multiMode ? (
              <>
                <div className="proj-checklist">
                  {projects.map((p) => (
                    <label key={p.id} className="proj-check">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(p.id)}
                        onChange={() => toggleProject(p.id)}
                      />
                      {p.color && (
                        <span className="proj-swatch" style={{ background: p.color }} />
                      )}
                      <span className="proj-check-name">{p.name}</span>
                    </label>
                  ))}
                  {archivedSelected.map((p) => (
                    <label key={p.id} className="proj-check proj-check-archived">
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(p.id)}
                        disabled={!selectedIds.includes(p.id)}
                        onChange={() =>
                          setSelectedIds((prev) => prev.filter((x) => x !== p.id))
                        }
                      />
                      {p.color && (
                        <span className="proj-swatch" style={{ background: p.color }} />
                      )}
                      <span className="proj-check-name">{p.name} (archived)</span>
                    </label>
                  ))}
                </div>
                <p className="hint">
                  Selected {itemNoun}s count together toward your targets. The timesheet keeps
                  them apart, prefixed by {itemNoun} name.
                </p>
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => {
                    setSelectedIds((prev) => prev.slice(0, 1));
                    setMultiExpanded(false);
                  }}
                >
                  Back to a single {itemNoun}
                </button>
              </>
            ) : (
              <>
                <select
                  id="project"
                  value={selectedIds[0] ?? ''}
                  onChange={(e) =>
                    setSelectedIds(e.target.value ? [Number(e.target.value)] : [])
                  }
                >
                  <option value="">Select a {itemNoun}…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => setMultiExpanded(true)}
                >
                  Track more than one {itemNoun}
                </button>
              </>
            )}
            {/* The project list is cached for 24h. In server-managed mode this is
                the only way to refresh it (there is no Connect button). */}
            {!standalone && (
              <>
                <button
                  type="button"
                  className="linkbtn"
                  onClick={() => onConnect(serverManaged ? '' : token)}
                  disabled={connecting}
                >
                  {connecting ? 'Refreshing…' : '↻ Refresh project list'}
                </button>
                <p className="hint">
                  Missing a new project? The list is cached for a day; refreshing costs 2 API
                  requests. Only your default Toggl workspace is shown.
                </p>
              </>
            )}
            {standalone && projects.length === 0 && (
              <p className="hint">
                No workspaces yet. Create one under <strong>Workspaces</strong> below.
              </p>
            )}
          </div>
        )}

        {showProjects && multiMode && (
          <div className="field">
            <label htmlFor="group-name">Group name (optional)</label>
            <input
              id="group-name"
              type="text"
              value={groupName}
              placeholder="e.g. Client work"
              onChange={(e) => setGroupName(e.target.value)}
            />
            <p className="hint">
              Title for the combined {itemNoun}s. Leave blank to show their initials.
            </p>
          </div>
        )}

        {showProjects && (
          <div className="field">
            <label htmlFor="timesheet-mode">Timesheet view</label>
            <select
              id="timesheet-mode"
              value={timesheetMode}
              onChange={(e) => setTimesheetMode(e.target.value as TimesheetMode)}
            >
              <option value="summary">
                Summary — combined per {billByProject ? itemNoun : 'billing tag'}
              </option>
              <option value="individual">Individual — one row per entry</option>
            </select>
            <p className="hint">
              The view the Timesheet button opens.
            </p>
          </div>
        )}

        <div className="toggle">
          <div className="t-text">
            <strong>Short week</strong>
            <span>
              Front-load the week: {fmtHoursLabel((9 * previewWeekly) / 40)} Mon–Wed for a lighter
              Friday. Off keeps an even {fmtHoursLabel(previewWeekly / 5)}. Both aim for{' '}
              {fmtHoursLabel(previewWeekly)}/week.
            </span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={shortFriday}
              onChange={(e) => setShortFriday(e.target.checked)}
            />
            <span className="slider" />
          </label>
        </div>

        <div className="field">
          <label htmlFor="weekly-hours">Hours worked per week</label>
          <input
            id="weekly-hours"
            type="number"
            inputMode="decimal"
            min={WEEKLY_MIN}
            max={WEEKLY_MAX}
            step={STEP}
            value={weeklyStr}
            onChange={(e) => setWeeklyStr(e.target.value)}
          />
          <p className="hint">
            Default 40h. Every target, floor and cap scales with it, so a 20h week is 4h a day.
            The break reminder doesn&apos;t change.
          </p>
        </div>

        <details className="advanced" open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced targets</summary>

          <div className="field">
            <label htmlFor="max-billable">Maximum individually billed timesheet</label>
            <input
              id="max-billable"
              type="number"
              inputMode="decimal"
              min={STEP}
              max={previewWeekly}
              step={STEP}
              value={maxBillStr}
              placeholder={numLabel(defaultMaxBillableHours(previewWeekly))}
              onChange={(e) => setMaxBillStr(e.target.value)}
            />
            <p className="hint">
              Longer single entries are flagged to split{' '}
              {standalone ? 'in the tracker' : 'in Toggl'}. Leave blank to scale with the week
              (currently{' '}
              <strong>{fmtHoursLabel(defaultMaxBillableHours(previewWeekly))}</strong>).
            </p>
          </div>

          <div className="field">
            <label htmlFor="min-working-day">Minimum target working day</label>
            <input
              id="min-working-day"
              type="number"
              inputMode="decimal"
              min={0}
              max={previewWeekly}
              step={STEP}
              value={minDayStr}
              placeholder={numLabel(defaultMinWorkingDayHours(previewWeekly))}
              onChange={(e) => setMinDayStr(e.target.value)}
            />
            <p className="hint">
              Near the end of the week, the day&apos;s target never drops below this. Set{' '}
              <strong>0</strong> for no floor, so Friday shows only what&apos;s left. Leave blank to
              scale with the week (currently{' '}
              <strong>{fmtHoursLabel(defaultMinWorkingDayHours(previewWeekly))}</strong>).
            </p>
          </div>

          <div className="toggle">
            <div className="t-text">
              <strong>Bill by {itemNoun}</strong>
              <span>
                Skip billing codes: each entry bills to its {itemNoun}, which becomes the line on
                timesheets and exports, and nothing is flagged as untagged. Billing-code options
                and the <strong>(X)</strong> / <strong>(!)</strong> markers don&apos;t apply. The
                time-off tag still works.
              </span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={billByProject}
                onChange={(e) => setBillByProject(e.target.checked)}
              />
              <span className="slider" />
            </label>
          </div>

          {!billByProject && (
          <div className="field">
            <label htmlFor="billing-prefix">Billing tag prefix</label>
            <input
              id="billing-prefix"
              type="text"
              value={billingPrefix}
              placeholder={DEFAULT_BILLING_TAG_PREFIX}
              onChange={(e) => setBillingPrefix(e.target.value)}
            />
            <p className="hint">
              {standalone ? 'Tags' : 'Toggl tags'} starting with this (e.g.{' '}
              <strong>{(billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX)}123</strong>) set the
              line an entry bills to. Entries without one are flagged to fix{' '}
              {standalone ? 'in the tracker' : 'in Toggl'}.
            </p>
          </div>
          )}

          {!billByProject && (
          <div className="toggle">
            <div className="t-text">
              <strong>Strip parentheses from billing codes</strong>
              <span>
                <strong>{(billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX)}123 (Phase 2)</strong>{' '}
                bills as{' '}
                <strong>{(billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX)}123</strong>, so codes
                that differ only in parentheses merge into one line. The <strong>(X)</strong> /{' '}
                <strong>(!)</strong> markers still work.
              </span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={stripCodeParens}
                onChange={(e) => setStripCodeParens(e.target.checked)}
              />
              <span className="slider" />
            </label>
          </div>
          )}

          <div className="field">
            <label htmlFor="time-off-tag">Time off tag</label>
            <input
              id="time-off-tag"
              type="text"
              value={timeOffTag}
              placeholder={DEFAULT_TIME_OFF_TAG}
              onChange={(e) => setTimeOffTag(e.target.value)}
            />
            <p className="hint">
              An entry with this tag, on a tracked {itemNoun}, marks its day as{' '}
              <strong>time off</strong> (a holiday or vacation). The day counts like a weekend: 0h
              expected, and the weekly goal and the &ldquo;Don&apos;t bill overtime&rdquo; cap drop
              by <strong>{fmtHoursLabel(previewWeekly / 5)}</strong>. The marker entry is never
              billed or exported; other work that day counts in full. Default:{' '}
              <strong>{DEFAULT_TIME_OFF_TAG}</strong>.
            </p>
          </div>

          <div className="field">
            <label htmlFor="rounding">Round timesheet to</label>
            <select
              id="rounding"
              value={roundingHours}
              onChange={(e) => setRoundingHours(Number(e.target.value))}
            >
              {ROUNDING_HOURS_OPTIONS.map((h) => (
                <option key={h} value={h}>
                  {roundingLabel(h)}
                </option>
              ))}
            </select>
            <p className="hint">
              Default <strong>15 minutes ({numLabel(DEFAULT_ROUNDING_HOURS)}h)</strong>. Use 12
              minutes if your client can&apos;t take quarter-hours. The dashboard and targets
              aren&apos;t rounded.
            </p>
          </div>

          {startWindowOptions.length > 0 && (
            <div className="field">
              <label htmlFor="start-window">Timesheet lines may start</label>
              <select
                id="start-window"
                value={selectedStartWindow ?? ''}
                onChange={(e) =>
                  setStartWindowHours(e.target.value === '' ? null : Number(e.target.value))
                }
              >
                <option value="">Same as the rounding unit ({gridMarks(roundingHours)})</option>
                {startWindowOptions.map((h) => (
                  <option key={h} value={h}>
                    {startWindowLabel(h)}
                  </option>
                ))}
              </select>
              <p className="hint">
                For clients that take <strong>{gridLabel(roundingHours)}</strong> durations but only
                accept start times on coarser marks. Each line in the Individual view starts on a
                mark; a line pushed past one moves to the <em>next</em>, leaving a gap. Durations,
                totals and the Summary view don&apos;t change.
              </p>
            </div>
          )}

          <div className="field">
            <label htmlFor="max-desc-len">Maximum description length</label>
            <input
              id="max-desc-len"
              type="number"
              inputMode="numeric"
              min={MAX_DESC_LEN_MIN}
              step={1}
              value={maxDescLenStr}
              placeholder="No limit"
              onChange={(e) => setMaxDescLenStr(e.target.value)}
            />
            <p className="hint">
              For clients whose systems reject long timesheet messages. Longer descriptions on
              screen, copied and in CSV/XLSX keep the parts that fit, followed by{' '}
              <strong>&ldquo;; …&rdquo;</strong>. A linked code&apos;s breakdown comes first, so
              it stays. PDFs show the full text unless you choose otherwise when exporting. A
              single description over the limit is cut and marked ✂; shorten it{' '}
              {standalone ? 'in the tracker' : 'in Toggl'}.
            </p>
          </div>

          {!billByProject && (
          <div className="field">
            <label>Linked billing codes</label>
            {codeMappings.length > 0 && (
              <div className="map-list">
                {codeMappings.map((m, i) => {
                  const gridOk = mappingGridCompatible(m.roundingHours, roundingHours);
                  return (
                    <div key={i} className="map-row">
                      <div className="map-grid">
                        <label className="map-cell">
                          <span className="map-cap">{standalone ? 'Workspace' : 'Project'}</span>
                          <select
                            value={m.projectId || ''}
                            onChange={(e) =>
                              updateMapping(i, { projectId: Number(e.target.value) || 0 })
                            }
                          >
                            <option value="">Pick a {itemNoun}…</option>
                            {/* Keep a stored id the list no longer offers (e.g. it
                                became the active workspace) instead of blanking. */}
                            {m.projectId > 0 && !mappingCandidateIds.includes(m.projectId) && (
                              <option value={m.projectId}>{projectNameOf(m.projectId)}</option>
                            )}
                            {mappingCandidateIds.map((id) => (
                              <option
                                key={id}
                                value={id}
                                disabled={codeMappings.some(
                                  (o, oi) => oi !== i && o.projectId === id
                                )}
                              >
                                {projectNameOf(id)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="map-cell map-cell-sm">
                          <span className="map-cap">Tag prefix</span>
                          <input
                            type="text"
                            value={m.tagPrefix}
                            placeholder="S"
                            onChange={(e) => updateMapping(i, { tagPrefix: e.target.value })}
                          />
                        </label>
                        <label className="map-cell map-cell-sm">
                          <span className="map-cap">Rounding</span>
                          <select
                            value={m.roundingHours}
                            onChange={(e) =>
                              updateMapping(i, { roundingHours: Number(e.target.value) })
                            }
                          >
                            {ROUNDING_HOURS_OPTIONS.map((h) => (
                              <option key={h} value={h}>
                                {Math.round(h * 60)} min
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="map-cell">
                          <span className="map-cap">Bills here as</span>
                          <input
                            type="text"
                            value={m.targetCode}
                            placeholder={`${billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX}-SUB-1`}
                            onChange={(e) => updateMapping(i, { targetCode: e.target.value })}
                          />
                        </label>
                        <button
                          type="button"
                          className="ws-icon ws-del map-del"
                          title="Remove this linked code"
                          onClick={() => removeMapping(i)}
                        >
                          🗑
                        </button>
                      </div>
                      <label className="map-ot">
                        <input
                          type="checkbox"
                          checked={!!m.noOvertime}
                          onChange={(e) => updateMapping(i, { noOvertime: e.target.checked })}
                        />
                        <span>It doesn&apos;t bill overtime — cap its week at</span>
                        <input
                          type="number"
                          inputMode="decimal"
                          min={WEEKLY_MIN}
                          max={WEEKLY_MAX}
                          step={STEP}
                          value={m.weeklyHours ?? DEFAULT_WEEKLY_HOURS}
                          disabled={!m.noOvertime}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            updateMapping(i, { weeklyHours: Number.isFinite(v) ? v : 0 });
                          }}
                        />
                        <span>h</span>
                      </label>
                      {!gridOk && (
                        <p className="map-warn">
                          Not on this sheet&apos;s {gridLabel(roundingHours)} grid; it will be saved
                          as {gridLabel(roundingHours)}.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <button
              type="button"
              className="linkbtn"
              onClick={addMapping}
              disabled={mappingCandidateIds.length === 0}
            >
              + Link a {itemNoun}&apos;s codes
            </button>
            <p className="hint">
              Bill {standalone ? 'another workspace' : 'a selected project'} as a{' '}
              <strong>single code</strong> here while it keeps its own billing tags.
              {standalone && ' Linking also adds it to the tracked workspaces above.'}{' '}
              Each day its entries are rounded on its own grid and the total goes on the code
              entered here, so the line matches that {itemNoun}&apos;s own timesheet. The per-code
              breakdown goes in the description. If it doesn&apos;t bill overtime, tick its cap:
              it is trimmed by <em>its own</em> rules first. This sheet&apos;s &ldquo;Don&apos;t
              bill overtime&rdquo; never trims a linked line, but counts it toward the cap. Its
              rounding must be this sheet&apos;s unit or a whole multiple of it.
            </p>
          </div>
          )}

          <div className="toggle">
            <div className="t-text">
              <strong>Don&apos;t bill overtime</strong>
              <span>
                Cap each week&apos;s billed total at {fmtHoursLabel(previewWeekly)}. The excess is
                trimmed off the timesheet (rounding down) and shown on an &ldquo;Overtime&rdquo;
                line: tracked, not billed.{' '}
                {!billByProject && (
                  <>
                    Codes ending in <strong>(X)</strong> are trimmed first; codes ending in{' '}
                    <strong>(!)</strong> are never trimmed. The markers aren&apos;t shown.{' '}
                  </>
                )}
                In the <strong>Summary</strong> view the working days are also evened out; weekend
                and time-off days stay billed in full.
              </span>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={noOvertime}
                onChange={(e) => setNoOvertime(e.target.checked)}
              />
              <span className="slider" />
            </label>
          </div>

          <div className="field">
            <label htmlFor="export-name">Name on exports</label>
            <input
              id="export-name"
              type="text"
              value={exportName}
              placeholder={standalone ? 'e.g. Jane Doe' : 'Defaults to your Toggl account name'}
              onChange={(e) => setExportName(e.target.value)}
            />
            <p className="hint">
              Printed in the PDF header. You can change it per export.
              {standalone ? '' : ' Blank uses your Toggl account name.'}
            </p>
          </div>

          <div className="field">
            <label>Export details</label>
            <p className="hint">
              Company, client, rate and the other details are set in the{' '}
              <strong>export dialog</strong> and saved{' '}
              {presets.length > 0 ? (
                <>
                  <strong>per workspace</strong>. A new workspace starts with the current values.
                </>
              ) : (
                <>with these settings. Stored workspaces each keep their own.</>
              )}{' '}
              {setExportFieldLabels.length > 0
                ? `Currently set: ${setExportFieldLabels.join(', ')}.`
                : 'None set yet.'}
            </p>
          </div>
        </details>

        {standalone ? (
          <div className="field">
            <label>Refresh interval</label>
            <p className="hint">
              Every <strong>30 seconds</strong>, and right after any change in the tracker. The
              timer still ticks every second.
            </p>
          </div>
        ) : cacheInterval !== null ? (
          <div className="field">
            <label>Refresh interval</label>
            <p className="hint">
              Set by the server: a shared cache refreshes from Toggl every{' '}
              <strong>{fmtInterval(cacheInterval)}</strong>, so extra devices and tabs cost no
              extra API requests. The timer still ticks every second.
            </p>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="refresh">Refresh interval</label>
            <select
              id="refresh"
              value={refreshSec}
              onChange={(e) => setRefreshSec(Number(e.target.value))}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.sec} value={o.sec}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="hint">
              The timer still ticks every second between fetches. Toggl&apos;s Free plan allows 30
              requests an hour, shared by all your devices.
            </p>
          </div>
        )}

        {showProjects && (
          <details
            ref={wsSectionRef}
            className="advanced ws-block"
            open={wsOpen}
            onToggle={(e) => setWsOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>Workspaces</summary>
            {standalone ? (
              <p className="hint">
                Each workspace holds its own settings and time entries, stored on the server. Click
                one to switch to it; ↻ saves the settings above into it. A new workspace copies the
                current settings but tracks its own entries.
              </p>
            ) : (
              <p className="hint">
                Save the settings above under a name, then click it to switch back. Editing
                settings doesn&apos;t change a stored workspace; ↻ overwrites it with the current
                settings.
              </p>
            )}

            {presets.length > 0 && (
              <ul className="ws-list">
                {presets.map((p) => {
                  const active =
                    activePresetId !== undefined
                      ? p.id === activePresetId
                      : presetMatches(p.value, initial);
                  return (
                    <li key={p.id} className={`ws-row${active ? ' active' : ''}`}>
                      {renamingId === p.id ? (
                        <>
                          <input
                            type="text"
                            className="ws-rename"
                            value={renameText}
                            autoFocus
                            onChange={(e) => setRenameText(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') commitRename();
                              if (e.key === 'Escape') setRenamingId(null);
                            }}
                          />
                          <button type="button" className="ws-icon" title="Save name" onClick={commitRename}>
                            ✓
                          </button>
                          <button
                            type="button"
                            className="ws-icon"
                            title="Cancel"
                            onClick={() => setRenamingId(null)}
                          >
                            ✕
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="ws-name"
                            title="Switch to this workspace"
                            onClick={() => recallPreset(p)}
                          >
                            {active && <span className="ws-dot" aria-label="current" />}
                            {standalone && p.color && (
                              <span className="proj-swatch" style={{ background: p.color }} />
                            )}
                            <span className="ws-name-text">{p.name}</span>
                          </button>
                          {standalone && (
                            <input
                              type="color"
                              className="ws-color"
                              title="Chip color"
                              defaultValue={p.color ?? '#0b83d9'}
                              // Commit on close; onChange would PATCH for every
                              // hue dragged through.
                              onBlur={(e) => {
                                if (e.target.value !== p.color) {
                                  onWorkspaceColor?.(p.id, e.target.value);
                                }
                              }}
                            />
                          )}
                          <button
                            type="button"
                            className="ws-icon"
                            title="Overwrite with the settings shown above"
                            onClick={() => updatePreset(p.id)}
                          >
                            ↻
                          </button>
                          <button
                            type="button"
                            className="ws-icon"
                            title="Rename"
                            onClick={() => startRename(p)}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className="ws-icon ws-del"
                            title="Delete"
                            onClick={() => deletePreset(p.id)}
                          >
                            🗑
                          </button>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="ws-new">
              <input
                type="text"
                value={newPresetName}
                placeholder="New workspace name"
                onChange={(e) => setNewPresetName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addPreset();
                }}
              />
              <button
                type="button"
                className="btn"
                // The first standalone workspace is created before anything is
                // selectable; the server points it at itself.
                disabled={!newPresetName.trim() || (!standalone && selectedIds.length === 0)}
                onClick={addPreset}
              >
                {standalone ? 'Create workspace' : 'Save current'}
              </button>
            </div>
          </details>
        )}

        <details
          className="advanced ws-block"
          open={syncOpen || !!sync?.conflict || !!syncNotice}
          onToggle={(e) => setSyncOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>Sync &amp; transfer</summary>

          {syncNotice && <div className="exp-done">✓ {syncNotice}</div>}

          {sync?.conflict && (
            <div className="err-msg">
              <p style={{ margin: '0 0 8px' }}>
                These settings were changed on another device (
                {sync.conflict.device || 'unknown device'},{' '}
                {new Date(sync.conflict.updatedAt).toLocaleString()}), and this device has
                unsynced changes. Pick one to keep; the other is overwritten everywhere.
              </p>
              <div className="row" style={{ justifyContent: 'flex-start' }}>
                <button type="button" className="btn" onClick={() => onSyncResolve?.('remote')}>
                  Use the other device&apos;s
                </button>
                <button type="button" className="btn" onClick={() => onSyncResolve?.('local')}>
                  Keep this device&apos;s
                </button>
              </div>
            </div>
          )}

          {sync?.enabled ? (
            sync.needsAuth ? (
              <div className="field">
                <label htmlFor="sync-pw">App password</label>
                <input
                  id="sync-pw"
                  type="password"
                  value={syncPw}
                  placeholder="Enter the app password to unlock sync"
                  autoComplete="off"
                  onChange={(e) => setSyncPw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && syncPw) onSyncPassword?.(syncPw);
                  }}
                />
                {syncPwError && <div className="err-msg">{syncPwError}</div>}
                <div className="row" style={{ justifyContent: 'flex-start' }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={!syncPw || !!syncPwBusy}
                    onClick={() => onSyncPassword?.(syncPw)}
                  >
                    {syncPwBusy ? 'Unlocking…' : 'Unlock sync'}
                  </button>
                </div>
                <p className="hint">
                  Sync needs this deployment&apos;s app password. Enter it once per device.
                </p>
              </div>
            ) : (
              <p className="hint">
                Your setup ({standalone ? '' : 'workspaces, '}targets, linked codes, export
                details) syncs across your devices. Changes upload after a moment; other devices
                pick them up when their page regains focus. The{' '}
                {standalone ? 'refresh interval stays' : 'Toggl API token and the refresh interval stay'}{' '}
                on each device.{' '}
                {sync.status === 'syncing' ? (
                  <strong>Syncing…</strong>
                ) : sync.status === 'error' ? (
                  <strong>{sync.error ?? 'Sync error.'}</strong>
                ) : sync.lastSyncedAt ? (
                  <>Last synced at {new Date(sync.lastSyncedAt).toLocaleTimeString()}.</>
                ) : null}
              </p>
            )
          ) : (
            <p className="hint">
              {sync?.misconfigured ??
                'Sync is off; settings live only in this browser. Move them with a settings ' +
                  'file below, or deploy with MONGODB_URI and APP_PASSWORD (plus ' +
                  'APP_MODE=toggl to keep Toggl) to sync.'}
            </p>
          )}

          <div className="field">
            <label>Settings file</label>
            <div className="row" style={{ justifyContent: 'flex-start' }}>
              <button type="button" className="btn" onClick={() => onExportFile?.()}>
                Download settings file
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => importInputRef.current?.click()}
              >
                Import settings file…
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) handleImportFile(f);
                }}
              />
            </div>
            {importMsg && <div className="err-msg">{importMsg}</div>}
            <p className="hint">
              Holds the same setup as sync ({standalone ? '' : 'workspaces, '}targets, export
              details), never the {standalone ? 'app password' : 'Toggl API token'}. Import it on
              another device or keep it as a backup.
            </p>
          </div>
        </details>

        {/* Per device, like the refresh interval */}
        <InstallAppBlock />

        <div className="row">
          {canClose && (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={selectedIds.length === 0}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
