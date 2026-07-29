'use client';

import { useState } from 'react';
import type { SourceMode, TrackProject } from '@/lib/source/types';
import {
  DEFAULT_WEEKLY_HOURS,
  DEFAULT_BILLING_TAG_PREFIX,
  DEFAULT_ROUNDING_HOURS,
  DEFAULT_TIME_OFF_TAG,
  ROUNDING_HOURS_OPTIONS,
  defaultMaxBillableHours,
  defaultMinWorkingDayHours,
  fmtHoursLabel,
} from '@/lib/calc';
import { mappingGridCompatible, type CodeMapping } from '@/lib/timesheet/mapping';

export type TimesheetMode = 'summary' | 'individual';

/**
 * A project the user has selected to track. Name and color are denormalised
 * (copied from the Toggl project list) so chips and timesheet prefixes render
 * before — or without — a fresh project fetch.
 */
export interface SelectedProject {
  id: number;
  name: string;
  color?: string;
}

export interface SettingsValue {
  token: string;
  // One or more projects that together count as "the project". A single
  // selection behaves exactly as before; multiple are an advanced option.
  selectedProjects: SelectedProject[];
  // Optional label shown as the title when more than one project is selected
  // (falls back to a generic title + initials chips when blank).
  groupName: string;
  shortFriday: boolean;
  // The master weekly target (hours). Scales the whole targets model; default 40.
  weeklyHours: number;
  // Advanced overrides. null = follow the weekly value proportionally; a number =
  // that absolute hours value, which stays put when weeklyHours later changes.
  maxBillableHours: number | null;
  minWorkingDayHours: number | null;
  // The prefix that marks a tag as a billing tag (default "D", e.g. "D123").
  billingTagPrefix: string;
  // When true, billing codes are used without their parenthetical groups — a
  // tag like "D123 (Phase 2)" bills and displays as "D123". The overtime
  // markers "(X)"/"(!)" are interpreted first, then the strip runs, then the
  // code is used, so the markers keep working. Off by default.
  stripCodeParens: boolean;
  // The tag that marks an entry as time off (default ".Time Off"). Its day
  // becomes a non-working day like a weekend — 0h target, the weekly goal and
  // the no-overtime cap drop by a day's worth — and the entry itself is never
  // billed, counted or exported. Other entries on that day still count in full.
  timeOffTag: string;
  // Granularity the timesheet rounds entries to, in hours. 0.25 (15 min) by
  // default; some clients can't enter quarter-hours, so 0.2 (12 min) is offered.
  roundingHours: number;
  // Optional cap (characters) on every merged timesheet description — some
  // clients' systems reject longer entry messages. null = no limit. When set,
  // combined descriptions keep whole parts that fit and drop the rest behind a
  // "; …" marker (see lib/timesheet/desc).
  maxDescriptionLength: number | null;
  // When true, the engagement disallows billing overtime: the timesheet caps each
  // week's billable total at weeklyHours, trimming lines down (codes marked with a
  // trailing "(X)" first) and showing the stripped time on an "Overtime" line.
  noOvertime: boolean;
  // Linked billing codes: selected projects whose entries carry another client's
  // billing tags (their own prefix and rounding grid) and bill on this timesheet
  // as one fixed code per day (see lib/timesheet/mapping).
  codeMappings: CodeMapping[];
  refreshSec: number;
  timesheetMode: TimesheetMode;
  // Name printed on exports (PDF header). Blank falls back to the Toggl account name.
  exportName: string;
}

/**
 * The settings a stored workspace captures: everything the user configures here
 * except the Toggl token (the account credential, shared across workspaces) and
 * the refresh interval (a device/network knob, not part of "a workspace"). A
 * workspace is a named snapshot you can recall from the dashboard to quick-switch
 * between configurations (e.g. different clients with their own targets/billing).
 */
export type PresetValue = Omit<SettingsValue, 'token' | 'refreshSec'>;

export interface SettingsPreset {
  id: string;
  name: string;
  value: PresetValue;
  // Standalone mode only: the stored workspace's chip color (server-assigned
  // from a palette, editable here). Toggl-mode presets don't carry one.
  color?: string;
}

/** Snapshot the preset-relevant fields out of a full settings value. */
export function toPresetValue(s: SettingsValue): PresetValue {
  return {
    selectedProjects: s.selectedProjects,
    groupName: s.groupName,
    shortFriday: s.shortFriday,
    weeklyHours: s.weeklyHours,
    maxBillableHours: s.maxBillableHours,
    minWorkingDayHours: s.minWorkingDayHours,
    billingTagPrefix: s.billingTagPrefix,
    stripCodeParens: s.stripCodeParens,
    timeOffTag: s.timeOffTag,
    roundingHours: s.roundingHours,
    maxDescriptionLength: s.maxDescriptionLength,
    noOvertime: s.noOvertime,
    codeMappings: s.codeMappings,
    timesheetMode: s.timesheetMode,
    exportName: s.exportName,
  };
}

/**
 * Whether a settings value currently matches a stored workspace. Projects are
 * compared by id set only (names/colors are denormalised and can drift as Toggl
 * changes), so recalling a workspace keeps reading as "active" after a refresh.
 */
export function presetMatches(value: PresetValue, s: SettingsValue): boolean {
  const ids = (ps: SelectedProject[]) =>
    ps
      .map((p) => p.id)
      .sort((a, b) => a - b)
      .join(',');
  // Order-insensitive mapping comparison; `?? []` covers presets stored before
  // linked codes existed, and the overtime fields normalise so presets stored
  // before those existed still match their unchanged settings.
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
    // `?? false` covers presets stored before the parentheses strip existed.
    (value.stripCodeParens ?? false) === (s.stripCodeParens ?? false) &&
    // `?? default` covers presets stored before the time-off tag existed.
    (value.timeOffTag ?? DEFAULT_TIME_OFF_TAG) === (s.timeOffTag ?? DEFAULT_TIME_OFF_TAG) &&
    value.roundingHours === s.roundingHours &&
    // `?? null` covers presets stored before the description limit existed.
    (value.maxDescriptionLength ?? null) === (s.maxDescriptionLength ?? null) &&
    value.noOvertime === s.noOvertime &&
    maps(value.codeMappings) === maps(s.codeMappings) &&
    value.timesheetMode === s.timesheetMode &&
    value.exportName === s.exportName
  );
}

/** A stable id for a new workspace (falls back when crypto.randomUUID is absent). */
function genPresetId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const WEEKLY_MIN = 1;
const WEEKLY_MAX = 80;
const STEP = 0.25; // 15-minute granularity for every hours field

/** Round to the nearest quarter-hour and keep it within [min, max]. */
function clampQuarter(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n / STEP) * STEP));
}

/** A compact numeric label without a trailing "h", e.g. 4 → "4", 2.5 → "2.5". */
function numLabel(n: number): string {
  return String(Number(n.toFixed(2)));
}

// The description-length field: empty (or unparseable) = no limit; otherwise a
// whole character count of at least 5 (the fitted text needs room for "; …").
const MAX_DESC_LEN_MIN = 5;
function parseMaxDescLen(s: string): number | null {
  const n = parseInt(s, 10);
  if (s.trim() === '' || !Number.isFinite(n)) return null;
  return Math.max(MAX_DESC_LEN_MIN, n);
}

// Dropdown label for a rounding granularity in hours. Whole hours read naturally
// ("1 hour"); sub-hour units show minutes with the hour value in parentheses.
function roundingLabel(hours: number): string {
  if (Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${Math.round(hours * 60)} minutes (${numLabel(hours)}h)`;
}

// Inline phrasing of a grid unit for prose ("1-hour", "60 min"), used in warnings.
function gridLabel(hours: number): string {
  if (Number.isInteger(hours)) return `${hours}-hour`;
  return `${Math.round(hours * 60)}-min`;
}

// Each option's implied requests/hour, so the user can see the budget impact
// (Toggl Free allows 30/hour).
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
  onWorkspaceCreate,
  onWorkspaceRecapture,
  onWorkspaceRename,
  onWorkspaceDelete,
  onWorkspaceColor,
}: {
  initial: SettingsValue;
  projects: TrackProject[];
  // Whether the project list has been successfully fetched. Distinguishes "still
  // loading" from "loaded and genuinely empty" — an empty workspace is a real
  // state (e.g. every project archived) that must still render archived rows.
  projectsLoaded: boolean;
  serverManaged: boolean;
  // Which track source the deployment runs. In standalone mode the "projects"
  // are stored workspaces, the token/refresh UI disappears, and the Workspaces
  // section below manages server documents through the onWorkspace* callbacks
  // instead of the localStorage preset list.
  mode?: SourceMode;
  // When non-null, the shared server cache governs the refresh cadence (in
  // seconds) and the per-device refresh picker is hidden.
  cacheInterval: number | null;
  authError: string | null;
  connecting: boolean;
  // Stored workspaces and a callback that persists the list. Workspace edits are
  // committed immediately (independent of the Save button below) — they're meta,
  // not part of the settings being edited. In standalone mode `presets` is the
  // server workspace list mapped to this shape and onPresetsChange is unused.
  presets: SettingsPreset[];
  onPresetsChange: (presets: SettingsPreset[]) => void;
  // Recall a workspace live (persist its settings immediately), so clicking one
  // in the list switches there at once — the same one-click recall as the topbar.
  onApply: (preset: SettingsPreset) => void;
  onConnect: (token: string) => void;
  onSave: (value: SettingsValue) => void;
  onClose: () => void;
  canClose: boolean;
  // Standalone mode: the workspace whose settings the form currently mirrors
  // (the "active" row in the Workspaces list below). A workspace can't be
  // linked onto its own timesheet, so it's excluded from the mapping picker.
  activeWorkspaceId?: number | null;
  // Standalone-mode workspace CRUD. Create resolves the stored workspace (as a
  // preset) so the form can switch to it, or null when the call failed. Delete
  // resolves whether the workspace was actually deleted (the wiring may cancel
  // via a confirm dialog), so the form only drops its references when it was.
  onWorkspaceCreate?: (name: string, settings: PresetValue) => Promise<SettingsPreset | null>;
  onWorkspaceRecapture?: (id: string, settings: PresetValue) => void;
  onWorkspaceRename?: (id: string, name: string) => void;
  onWorkspaceDelete?: (id: string) => Promise<boolean>;
  onWorkspaceColor?: (id: string, color: string) => void;
}) {
  const [token, setToken] = useState(initial.token);
  const [selectedIds, setSelectedIds] = useState<number[]>(
    initial.selectedProjects.map((p) => p.id)
  );
  const [groupName, setGroupName] = useState(initial.groupName);
  // The multiselect is an advanced affordance: it shows once the user opts in
  // via "more than one", or whenever more than one project is already selected.
  // It auto-collapses back to the plain dropdown the moment the selection drops
  // to a single project.
  const [multiExpanded, setMultiExpanded] = useState(initial.selectedProjects.length > 1);
  const [shortFriday, setShortFriday] = useState(initial.shortFriday);
  const [refreshSec, setRefreshSec] = useState(initial.refreshSec);
  const [timesheetMode, setTimesheetMode] = useState<TimesheetMode>(initial.timesheetMode);
  const [exportName, setExportName] = useState(initial.exportName);

  // Hours fields are kept as raw strings so a half-typed value (e.g. "3.") never
  // snaps mid-edit; they're parsed and clamped on save. An empty advanced field
  // means "auto" (null) — it then follows the weekly value proportionally.
  const [weeklyStr, setWeeklyStr] = useState(numLabel(initial.weeklyHours));
  const [maxBillStr, setMaxBillStr] = useState(
    initial.maxBillableHours === null ? '' : numLabel(initial.maxBillableHours)
  );
  const [minDayStr, setMinDayStr] = useState(
    initial.minWorkingDayHours === null ? '' : numLabel(initial.minWorkingDayHours)
  );
  const [billingPrefix, setBillingPrefix] = useState(initial.billingTagPrefix);
  // `!!` covers settings stored before the parentheses strip existed.
  const [stripCodeParens, setStripCodeParens] = useState(!!initial.stripCodeParens);
  const [timeOffTag, setTimeOffTag] = useState(initial.timeOffTag ?? DEFAULT_TIME_OFF_TAG);
  const [roundingHours, setRoundingHours] = useState(initial.roundingHours);
  // Kept as a raw string like the hours fields; empty = no limit (null).
  const [maxDescLenStr, setMaxDescLenStr] = useState(
    initial.maxDescriptionLength == null ? '' : String(initial.maxDescriptionLength)
  );
  const [noOvertime, setNoOvertime] = useState(initial.noOvertime);
  const [codeMappings, setCodeMappings] = useState<CodeMapping[]>(initial.codeMappings ?? []);
  const [showAdvanced, setShowAdvanced] = useState(
    initial.maxBillableHours !== null ||
      initial.minWorkingDayHours !== null ||
      initial.billingTagPrefix !== DEFAULT_BILLING_TAG_PREFIX ||
      !!initial.stripCodeParens ||
      (initial.timeOffTag ?? DEFAULT_TIME_OFF_TAG) !== DEFAULT_TIME_OFF_TAG ||
      initial.roundingHours !== DEFAULT_ROUNDING_HOURS ||
      initial.maxDescriptionLength != null ||
      initial.noOvertime ||
      (initial.codeMappings?.length ?? 0) > 0 ||
      initial.exportName.trim() !== ''
  );

  const standalone = mode === 'standalone';
  const tokenConnected = projects.length > 0;

  // Previously selected projects that no longer appear in the fetched list —
  // archived (or deleted) at the source. They keep a row in the checklist so the
  // user can keep or drop them, but a drop is one-way: only the live list can
  // (re)select a project, so an unchecked archived row is disabled rather than
  // removed. Gated on a completed fetch (not list length: a successful fetch may
  // genuinely return no active projects) so a still-loading list doesn't mark
  // the whole selection archived.
  const archivedSelected = projectsLoaded
    ? initial.selectedProjects.filter((sp) => !projects.some((p) => p.id === sp.id))
    : [];

  // Archived leftovers keep the picker visible even when the active list is
  // empty (e.g. every selected project has since been archived) — otherwise
  // they could never be unchecked.
  const showProjects = serverManaged || tokenConnected || archivedSelected.length > 0;
  // What a selectable item is called in this mode. In standalone the app's own
  // stored workspaces fill the "project" slot (same numeric-id contract).
  const itemNoun = standalone ? 'workspace' : 'project';

  // Show the multiselect once opted into, or whenever more than one is selected.
  // Staying open while editing is deliberate: collapsing the instant the count
  // hits one would make it impossible to pick a second project. It returns to the
  // plain dropdown when Settings is reopened with a single project saved (see the
  // multiExpanded initial value).
  const multiMode = multiExpanded || selectedIds.length > 1;

  const toggleProject = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  // The weekly value currently being edited (clamped), used to live-preview the
  // proportional defaults shown as placeholders in the advanced fields.
  const parsedWeekly = parseFloat(weeklyStr);
  const previewWeekly = Number.isFinite(parsedWeekly)
    ? clampQuarter(parsedWeekly, WEEKLY_MIN, WEEKLY_MAX)
    : DEFAULT_WEEKLY_HOURS;

  // Build the settings value from the current form state (parsing/clamping the
  // raw fields). Shared by Save and by "store as a workspace", so a workspace
  // snapshots exactly what the form would save.
  const buildValue = (): SettingsValue => {
    // Resolve each selected id to its full {id, name, color} from the loaded list,
    // falling back to whatever we already had stored (covers an archived project
    // that no longer appears in the active list).
    const selectedProjects: SelectedProject[] = selectedIds.map((id) => {
      const proj = projects.find((p) => p.id === id);
      if (proj) return { id: proj.id, name: proj.name, color: proj.color };
      return initial.selectedProjects.find((p) => p.id === id) ?? { id, name: '' };
    });
    const weeklyHours = previewWeekly;
    // An empty (or unparseable) advanced field is "auto" (null); otherwise clamp
    // the override to a quarter-hour within [min, weeklyHours]. The Friday floor
    // may be set to 0 ("no floor — show whatever's actually left, even nothing"),
    // but the billable cap keeps a quarter-hour minimum (a 0h cap is meaningless).
    const parseOverride = (s: string, min: number): number | null => {
      const n = parseFloat(s);
      if (s.trim() === '' || !Number.isFinite(n)) return null;
      return clampQuarter(n, min, weeklyHours);
    };
    // Guard against a stray value; only the offered granularities are valid.
    const finalRounding = ROUNDING_HOURS_OPTIONS.includes(
      roundingHours as (typeof ROUNDING_HOURS_OPTIONS)[number]
    )
      ? roundingHours
      : DEFAULT_ROUNDING_HOURS;
    // Linked codes: keep only complete rows on selected projects (one per
    // project). A grid that would take figures off this sheet's rounding unit is
    // coerced to the sheet's own — the equality with the sub-client sheet only
    // works when its rounded totals still land on this grid. The sub-client's
    // weekly cap is clamped like the main weekly field.
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
      // In server-managed mode the token always stays empty so the proxy uses
      // the server's TOGGL_API_TOKEN.
      token: serverManaged ? '' : token,
      selectedProjects,
      groupName: selectedProjects.length > 1 ? groupName.trim() : '',
      shortFriday,
      weeklyHours,
      maxBillableHours: parseOverride(maxBillStr, STEP),
      minWorkingDayHours: parseOverride(minDayStr, 0),
      // An empty prefix would match every tag, so fall back to the default.
      billingTagPrefix: billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX,
      stripCodeParens,
      // An empty tag can't mark anything, so fall back to the default.
      timeOffTag: timeOffTag.trim() || DEFAULT_TIME_OFF_TAG,
      roundingHours: finalRounding,
      maxDescriptionLength: parseMaxDescLen(maxDescLenStr),
      noOvertime,
      codeMappings: cleanedMappings,
      refreshSec,
      timesheetMode,
      exportName: exportName.trim(),
    };
  };

  const handleSave = () => onSave(buildValue());

  // ---- Linked billing codes ----
  // Rows are edited freely (a half-filled row is fine mid-edit); buildValue keeps
  // only complete rows on selected projects when saving.
  //
  // What a row may target: in Toggl mode the tracked projects (membership in the
  // tracked set holds by construction); in standalone mode every OTHER workspace
  // — a mapped workspace's entries must load with this sheet's, so picking one
  // adds it to the tracked set (the standalone equivalent of the same rule).
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
      // New rows start on this sheet's own grid — always compatible.
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

  // ---- Workspaces (stored settings) ----
  // Starts open on a fresh standalone install (creating the first workspace is
  // the very first thing to do); user toggling owns it from then on.
  const [wsOpen, setWsOpen] = useState(standalone && presets.length === 0);
  const [newPresetName, setNewPresetName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  // Load a stored workspace back into the form. Doesn't save on its own — the
  // user reviews and clicks Save (the dashboard switcher applies directly).
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
    setStripCodeParens(!!v.stripCodeParens); // presets stored before the strip existed
    // `??` covers presets stored before the time-off tag existed.
    setTimeOffTag(v.timeOffTag ?? DEFAULT_TIME_OFF_TAG);
    setRoundingHours(v.roundingHours);
    // `== null` covers presets stored before the description limit existed.
    setMaxDescLenStr(v.maxDescriptionLength == null ? '' : String(v.maxDescriptionLength));
    setNoOvertime(v.noOvertime);
    setCodeMappings(v.codeMappings ?? []); // presets stored before linked codes existed
    if (
      v.maxBillableHours !== null ||
      v.minWorkingDayHours !== null ||
      v.billingTagPrefix !== DEFAULT_BILLING_TAG_PREFIX ||
      !!v.stripCodeParens ||
      (v.timeOffTag ?? DEFAULT_TIME_OFF_TAG) !== DEFAULT_TIME_OFF_TAG ||
      v.roundingHours !== DEFAULT_ROUNDING_HOURS ||
      v.maxDescriptionLength != null ||
      v.noOvertime ||
      (v.codeMappings?.length ?? 0) > 0 ||
      v.exportName.trim() !== ''
    ) {
      setShowAdvanced(true);
    }
  };

  // In standalone mode these operate on server workspace documents through the
  // onWorkspace* callbacks; in Toggl mode they edit the localStorage preset list.
  const addPreset = async () => {
    const name = newPresetName.trim();
    if (!name) return;
    if (standalone) {
      // The server snapshots the current form's settings but points the new
      // workspace's selection at ITSELF; on success the form switches to it.
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
        // Drop the form's own references to the deleted workspace (tracked
        // selection, linked billing code) — mirroring the strip the server
        // performed on the stored settings.
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
  // Clicking a workspace recalls it: switch live (persist) and mirror it into the
  // form, so Save/Cancel stay consistent and the active marker updates at once.
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
            This deployment keeps its own store of time entries — there is no Toggl account to
            connect. Pick the workspace (or workspaces) to view below, and track time on the{' '}
            <strong>Tracker</strong> page. Coming from Toggl? Bring your history over on the{' '}
            <a href="/import">Import</a> page.
          </p>
        ) : serverManaged ? (
          <p className="hint">
            The Toggl API token is configured on the server, so there&apos;s nothing to enter
            here. Just pick your project (or projects) below.
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
                (bottom of the page). It is stored only in this browser and sent through this
                app&apos;s own proxy.
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
                  Every selected {itemNoun} counts as one — all of them together are
                  &ldquo;the project&rdquo; for your targets and ring. They stay
                  separate only in the timesheet, prefixed by {itemNoun} name.
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
            {/* The Toggl project list is cached for 24h to conserve the request
                budget, so a project created in Toggl after connecting won't show
                until a forced refresh. In server-managed mode this link is the
                ONLY such affordance (there's no Connect button to double as one).
                Standalone workspaces are managed right below, so no refresh
                affordance is needed there. */}
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
                  Just created a project in Toggl and it&apos;s not listed? The list is cached for
                  a day — refresh it here (costs 2 API requests). Only projects from your default
                  Toggl workspace are shown.
                </p>
              </>
            )}
            {standalone && projects.length === 0 && (
              <p className="hint">
                No workspaces yet — create your first one in the <strong>Workspaces</strong>{' '}
                section below.
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
              Shown as the title when several projects are tracked together. Leave
              blank to just show their initials.
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
              <option value="summary">Summary — combined per billing tag</option>
              <option value="individual">Individual — one row per entry</option>
            </select>
            <p className="hint">
              Which view the Timesheet button opens. Summary groups each day&apos;s entries by
              billing tag and rounds to your chosen unit; Individual lists entries one by one.
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
            The whole week&apos;s target. Defaults to 40h; set it lower for a part-time project (or
            higher) and every target, floor and cap rescales proportionally — e.g. a 20h week
            becomes an even 4h/day. The break reminder is unaffected.
          </p>
        </div>

        <details className="advanced" open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced targets</summary>

          <div className="field">
            <label htmlFor="max-billable">Maximal individually billed timesheet</label>
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
              A single entry longer than this can&apos;t be billed as one line — the timesheet flags
              it to split {standalone ? 'in the tracker' : 'in Toggl'}. Leave blank to auto-scale
              with the week (currently{' '}
              <strong>{fmtHoursLabel(defaultMaxBillableHours(previewWeekly))}</strong>).
            </p>
          </div>

          <div className="field">
            <label htmlFor="min-working-day">Minimal target working day</label>
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
              The Friday floor: once the week is nearly done, the day&apos;s target never drops
              below this (so a stray hour isn&apos;t worth a trip in). Set <strong>0</strong> for no
              floor — Friday then shows exactly what&apos;s left, or nothing once you&apos;re over.
              Leave blank to auto-scale with the week (currently{' '}
              <strong>{fmtHoursLabel(defaultMinWorkingDayHours(previewWeekly))}</strong>).
            </p>
          </div>

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
              {standalone ? 'Tags' : 'Toggl tags'} starting with this mark which line an entry
              bills to (e.g.{' '}
              <strong>{(billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX)}123</strong>). Entries
              without one are flagged so they can be fixed{' '}
              {standalone ? 'in the tracker' : 'in Toggl'}. Defaults to{' '}
              <strong>{DEFAULT_BILLING_TAG_PREFIX}</strong>.
            </p>
          </div>

          <div className="toggle">
            <div className="t-text">
              <strong>Strip parentheses from billing codes</strong>
              <span>
                Use each billing code without its parenthetical name — a tag like{' '}
                <strong>{(billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX)}123 (Phase 2)</strong>{' '}
                lands on the timesheet and exports as{' '}
                <strong>{(billingPrefix.trim() || DEFAULT_BILLING_TAG_PREFIX)}123</strong>. The
                overtime markers <strong>(X)</strong> / <strong>(!)</strong> are interpreted first
                and keep working; codes that differ only in the parenthetical then merge into one
                line.
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
              An entry carrying this tag (any length) marks its whole day as{' '}
              <strong>time off</strong> — a state holiday or vacation day. The day then behaves
              like a weekend: 0h expected, and the weekly goal and the &ldquo;Don&apos;t bill
              overtime&rdquo; cap drop by a day&apos;s worth (currently{' '}
              <strong>{fmtHoursLabel(previewWeekly / 5)}</strong> each). The marker entry itself is
              never billed, counted or exported; any <em>other</em> work tracked that day still
              counts in full, like weekend work. Only entries on the tracked{' '}
              {itemNoun}s mark a day off. Defaults to <strong>{DEFAULT_TIME_OFF_TAG}</strong>.
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
              The unit the timesheet rounds each entry to. Defaults to{' '}
              <strong>15 minutes ({numLabel(DEFAULT_ROUNDING_HOURS)}h)</strong>; pick{' '}
              <strong>12 minutes (0.2h)</strong> if your client can&apos;t bill quarter-hours, or{' '}
              <strong>1 hour</strong> if they bill in whole hours. The dashboard and targets are
              unaffected.
            </p>
          </div>

          <div className="field">
            <label htmlFor="max-desc-len">Maximal description length</label>
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
              Some clients&apos; systems reject timesheet messages over a character limit. Set it
              here and every description this timesheet produces (on screen, copied, and in
              CSV/XLSX exports — PDFs show the full text by default, with a per-export choice)
              stays within it: combined descriptions keep the parts that fit and drop the rest
              behind a <strong>&ldquo;; …&rdquo;</strong> marker (a linked code&apos;s per-code
              breakdown always comes first, so it survives). A single entry whose own description
              is already over the limit is cut and flagged with ✂ — shorten it{' '}
              {standalone ? 'in the tracker' : 'in Toggl'}. Leave blank for no limit.
            </p>
          </div>

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
                            {/* A stored mapping can reference an id the candidate
                                list no longer offers (e.g. it became the active
                                workspace) — keep it visible instead of blanking. */}
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
                          Off this sheet&apos;s {gridLabel(roundingHours)} grid — will be saved as{' '}
                          {gridLabel(roundingHours)} so the figures stay tidy.
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
              <strong>single code</strong> on this timesheet while it keeps its own billing tags.
              {standalone &&
                ' Linking a workspace also adds it to the tracked set above — its entries have to load with this sheet’s.'}{' '}
              Its entries are grouped by their own tags (the prefix
              above), rounded per day on its own grid, and each day&apos;s total lands on the one
              code entered here — so this sheet&apos;s line always equals that {itemNoun}&apos;s own
              timesheet, day for day (its per-code breakdown is kept in the cell description).
              If the linked engagement itself doesn&apos;t bill overtime, tick its cap above: its
              week is then trimmed by <em>its own</em> rules first and this sheet bills whatever
              its timesheet shows. This sheet&apos;s own &ldquo;Don&apos;t bill overtime&rdquo;
              never trims a linked line (it only counts toward the cap), and the linked rounding
              must be this sheet&apos;s unit or a whole multiple of it.
            </p>
          </div>

          <div className="toggle">
            <div className="t-text">
              <strong>Don&apos;t bill overtime</strong>
              <span>
                Cap each week&apos;s billed total at your{' '}
                {fmtHoursLabel(previewWeekly)} weekly hours. Anything over is trimmed off the
                timesheet (rounding down) and shown as an &ldquo;Overtime&rdquo; line — still tracked,
                just not billed. Codes ending in <strong>(X)</strong> are trimmed first; codes
                ending in <strong>(!)</strong> are <em>never</em> trimmed (they bill whole and the
                cut falls on the rest). Neither marker is ever shown. In the{' '}
                <strong>Summary</strong> view the weekdays are also evened out — the weekend and
                any time-off days stay billed in full and the working days are levelled toward
                (weekly hours − those days) ÷ their count.
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
              The default name printed in the header of PDF exports (you can still override it per
              export).{standalone ? '' : ' Leave blank to use your Toggl account name.'}
            </p>
          </div>
        </details>

        {standalone ? (
          <div className="field">
            <label>Refresh interval</label>
            <p className="hint">
              The app&apos;s own store has no rate limit, so every device refreshes every{' '}
              <strong>30 seconds</strong> — and instantly after any change made in the tracker.
              The on-screen counter still updates every second in between.
            </p>
          </div>
        ) : cacheInterval !== null ? (
          <div className="field">
            <label>Refresh interval</label>
            <p className="hint">
              Managed by the server: a shared cache refreshes from Toggl every{' '}
              <strong>{fmtInterval(cacheInterval)}</strong> and serves every device from it, so
              opening this on extra devices/tabs costs no additional API requests. The on-screen
              counter still updates every second between refreshes.
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
              How often to fetch from Toggl. The on-screen counter still updates every second
              between refreshes. Toggl&apos;s Free plan allows 30 requests/hour.
            </p>
          </div>
        )}

        {showProjects && (
          <details
            className="advanced ws-block"
            open={wsOpen}
            onToggle={(e) => setWsOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary>Workspaces</summary>
            {standalone ? (
              <p className="hint">
                Workspaces are stored on the server: each one owns its settings snapshot{' '}
                <em>and</em> its tracked time entries, and syncs across your devices. Click one to
                switch to it instantly; use ↻ to re-capture the settings shown above into it. A
                new workspace copies the current settings but tracks itself.
              </p>
            ) : (
              <p className="hint">
                Store the settings shown above as a named workspace, then switch between saved
                configurations — click a workspace below (or the 🗂 button in the topbar) to recall
                it instantly. Editing settings never changes a stored workspace; use ↻ to
                re-capture the current settings into one.
              </p>
            )}

            {presets.length > 0 && (
              <ul className="ws-list">
                {presets.map((p) => {
                  const active = presetMatches(p.value, initial);
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
                            title="Recall this workspace (switch to it now)"
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
                              // Commit when the picker closes — onChange would
                              // fire a PATCH for every hue dragged through.
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
                // A first standalone workspace is created before anything can be
                // selected — the server points it at itself.
                disabled={!newPresetName.trim() || (!standalone && selectedIds.length === 0)}
                onClick={addPreset}
              >
                {standalone ? 'Create workspace' : 'Save current'}
              </button>
            </div>
          </details>
        )}

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
