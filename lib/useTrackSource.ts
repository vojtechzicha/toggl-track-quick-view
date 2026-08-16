'use client';

// Shared track-source connection + polling for the dashboard, the timesheet
// and the tracker pages.
//
// This hook owns everything that talks to the data source: loading settings,
// resolving the server-managed / password-gate status, connecting
// (cache-first), and the self-scheduling poll that fetches the week's entries.
// Every page consumes the SAME hook so they share one fetch cadence and never
// double-spend a metered source's request budget. Page-specific derivations
// (the ring, timelines, the timesheet grid) live in the pages; this hook just
// hands back the raw ingredients (entries, nowMs, settings, gate state,
// errors).
//
// The source itself is a TrackBackend (lib/source/types.ts), picked from
// AppConfig.mode once /api/config resolves: the Toggl proxy client, or — in
// standalone mode — the app's own MongoDB-backed store. Standalone mode also
// brings mutations (the tracker writes entries; Settings manages workspaces),
// which this hook wraps with optimistic updates against its entries state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getConfig } from '@/lib/source/config';
import { hasValidAuth, login } from '@/lib/source/auth';
import { ApiError, errorDetail, isRateLimit, isAuthRequired } from '@/lib/source/errors';
import { togglBackend } from '@/lib/source/toggl';
import {
  standaloneBackend,
  listWorkspaces,
  workspacesToProjects,
  createWorkspaceApi,
  updateWorkspaceApi,
  deleteWorkspaceApi,
  createEntryApi,
  updateEntryApi,
  deleteEntryApi,
  stopEntryApi,
  type EntryInput,
  type StoreWorkspace,
} from '@/lib/source/standalone';
import type { FetchedEntries, SourceMode, TrackProject } from '@/lib/source/types';
import { presetMatches } from '@/components/SettingsPanel';
import type {
  SettingsValue,
  SelectedProject,
  SettingsPreset,
  PresetValue,
} from '@/components/SettingsPanel';
import {
  TimeEntry,
  startOfDay,
  startOfWeek,
  DEFAULT_WEEKLY_HOURS,
  DEFAULT_BILLING_TAG_PREFIX,
  DEFAULT_ROUNDING_HOURS,
  DEFAULT_TIME_OFF_TAG,
} from '@/lib/calc';
import {
  buildSyncPayload,
  applySyncPayload,
  payloadHash,
  loadSyncMeta,
  saveSyncMeta,
  fetchSyncDoc,
  pushSyncDoc,
  deviceLabel,
  SyncConflictError,
} from '@/lib/sync/client';
import { SYNC_PAYLOAD_VERSION, type SyncDoc, type SyncPayload } from '@/lib/sync/model';
import {
  EMPTY_EXPORT_FIELDS,
  clearLegacyExportFields,
  exportFieldsEqual,
  normalizeExportFields,
  readLegacyExportFields,
  type ExportFieldValues,
} from '@/lib/exportFields';

const LS_KEY = 'tqv.settings.v1';
const CACHE_KEY = 'tqv.cache.v1';
const REQLOG_KEY = 'tqv.reqlog.v1';
const CACHE_TTL = 24 * 3600 * 1000; // me/projects cache lifetime
const HOUR_MS = 3600 * 1000;
const DEFAULT_REFRESH_SEC = 180; // ~20 requests/hour, well under Toggl's limit
// The standalone store has no request budget, so it polls briskly at a fixed
// cadence (plus an instant refetch after every mutation).
export const STANDALONE_REFRESH_SEC = 30;

export interface StoredSettings extends SettingsValue {
  workspaceId: number | null;
  // The account's display name, captured at connect time. Used as the default
  // "name" on exports; not directly user-edited (see exportName).
  accountName: string;
  // Saved "workspaces": named snapshots of the configurable settings the user can
  // recall from Settings → Workspaces to quick-switch between setups (see
  // SettingsPreset).
  // Toggl mode only — in standalone mode workspaces live in the store instead.
  presets: SettingsPreset[];
  // Id of the workspace last recalled (a preset id in Toggl mode, the stored
  // workspace's numeric id as a string in standalone). A pointer, not a
  // setting: it disambiguates which workspace these settings mirror when two
  // of them are identical apart from their export details — which
  // presetMatches deliberately cannot see. Always re-checked against the
  // content before it is used, so settings edited away from that workspace
  // never keep writing into it.
  activePresetId: string | null;
}

export const DEFAULTS: StoredSettings = {
  token: '',
  workspaceId: null,
  accountName: '',
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
  refreshSec: DEFAULT_REFRESH_SEC,
  timesheetMode: 'summary',
  exportName: '',
  exportFields: EMPTY_EXPORT_FIELDS,
  presets: [],
  activePresetId: null,
};

/**
 * Apply a stored workspace over the current settings, returning the new value to
 * persist. Refreshes each recalled project's name/color from the live project
 * list (denormalised copies drift as the source changes); the token, workspace
 * and stored-workspace list are left untouched.
 */
export function applyPreset(
  settings: StoredSettings,
  preset: SettingsPreset,
  projects: TrackProject[]
): StoredSettings {
  return {
    ...settings,
    ...preset.value,
    selectedProjects: enrichSelected(preset.value.selectedProjects, projects),
    // A preset stored before linked codes existed has no key to spread in, which
    // would otherwise leak the current mappings into the recalled workspace.
    codeMappings: preset.value.codeMappings ?? [],
    // Same for presets stored before the description limit existed.
    maxDescriptionLength: preset.value.maxDescriptionLength ?? null,
    // And for presets stored before the time-off tag existed.
    timeOffTag: preset.value.timeOffTag ?? DEFAULT_TIME_OFF_TAG,
    // And for presets stored before the parentheses strip existed.
    stripCodeParens: preset.value.stripCodeParens ?? false,
    // Export identity fields are per workspace: recalling one recalls its own
    // company/client/rate, so another client's details can never ride along.
    // A workspace stored BEFORE they were scoped carries none at all — it
    // inherits the ones in use instead of blanking them. (A workspace whose
    // snapshot does carry them keeps them even when they're all empty: that is
    // a workspace deliberately without export details, not an unscoped one.)
    exportFields: preset.value.exportFields
      ? normalizeExportFields(preset.value.exportFields)
      : normalizeExportFields(settings.exportFields),
    // Remember WHICH workspace this is, so later writes (export details) reach
    // it and not a twin with the same tracking settings.
    activePresetId: preset.id,
  };
}

/**
 * Hash of what a never-configured device looks like: default settings (keeping
 * only the connect-derived workspace/account identity) and no export fields.
 * A fresh device matching this adopts the server's synced setup silently
 * instead of raising a conflict banner over nothing.
 */
function pristineHash(s: StoredSettings): string {
  return payloadHash(
    buildSyncPayload({ ...DEFAULTS, workspaceId: s.workspaceId, accountName: s.accountName })
  );
}

function loadSettings(): StoredSettings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    // No settings yet still goes through the migrations below: the export
    // identity fields lived in keys of their own, which can outlive a cleared
    // settings entry.
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    // Migrate the v1 single-project shape ({ projectId, projectName }) to the
    // selectedProjects array — in place, so every other stored setting survives.
    if (!parsed.selectedProjects && parsed.projectId != null) {
      parsed.selectedProjects = [
        { id: parsed.projectId, name: (parsed.projectName as string) ?? '' },
      ];
    }
    delete parsed.projectId;
    delete parsed.projectName;
    const loaded = { ...DEFAULTS, ...parsed } as StoredSettings;
    // Export identity fields used to live in their own device-wide localStorage
    // keys. Fold them in once (they become the active — and therefore the
    // inherited — set) and drop the old keys.
    if (!parsed.exportFields) {
      const legacy = readLegacyExportFields();
      if (legacy) {
        loaded.exportFields = legacy;
        // Write the migrated settings back BEFORE dropping the old keys — a
        // migration that only lived in memory would lose them on the next load.
        try {
          window.localStorage.setItem(LS_KEY, JSON.stringify(loaded));
          clearLegacyExportFields();
        } catch {
          /* private mode / quota — the old keys stay put and we migrate again */
        }
      }
    }
    loaded.exportFields = normalizeExportFields(loaded.exportFields);
    return loaded;
  } catch {
    return DEFAULTS;
  }
}

// ---- me/projects cache (avoids spending the request budget on every reload) ----
// Toggl mode only: the standalone workspace list is unmetered and changes from
// Settings, so it is always fetched live.
interface Cache {
  workspaceId: number;
  projects: TrackProject[];
  accountName?: string;
  at: number;
}
function loadCache(): Cache | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as Cache) : null;
  } catch {
    return null;
  }
}
/**
 * Refresh each selected project's denormalised name/color from the freshly loaded
 * list (names/colors can change at the source, and migrated v1 selections have no
 * color yet). Unknown ids — e.g. an archived project — keep their stored copy.
 */
function enrichSelected(selected: SelectedProject[], projects: TrackProject[]): SelectedProject[] {
  return selected.map((sp) => {
    const full = projects.find((p) => p.id === sp.id);
    return full ? { id: full.id, name: full.name, color: full.color } : sp;
  });
}

function saveCache(c: Cache) {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* ignore */
  }
}

// ---- rolling 60-minute request log (estimate, to show budget usage) ----
function pruneLoad(): number[] {
  try {
    const arr = JSON.parse(window.localStorage.getItem(REQLOG_KEY) || '[]');
    const cutoff = Date.now() - HOUR_MS;
    return Array.isArray(arr) ? arr.filter((t: number) => t > cutoff) : [];
  } catch {
    return [];
  }
}
function recordReqs(n: number): number {
  const arr = pruneLoad();
  const now = Date.now();
  for (let i = 0; i < n; i++) arr.push(now);
  try {
    window.localStorage.setItem(REQLOG_KEY, JSON.stringify(arr));
  } catch {
    /* ignore */
  }
  return arr.length;
}

export function fmtInterval(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} min` : `${sec}s`;
}

// The Toggl importer spends the same hourly budget the Toggl poll does, so it
// shares this rolling log (the /import page throttles itself against it).
/** Toggl requests recorded in the last rolling hour. */
export function togglRequestsThisHour(): number {
  return pruneLoad().length;
}
/** Record `n` Toggl requests; returns the new rolling-hour count. */
export function recordTogglRequests(n: number): number {
  return recordReqs(n);
}

// ---- Cross-tab store change notifications (standalone mode) ----
// A mutation made on the tracker must not leave a dashboard/timesheet that is
// open in ANOTHER tab or PWA window showing stale numbers until its next 30s
// poll. Every successful mutation posts here; every hook instance listens and
// refetches immediately. (Within one tab this is a no-op — a BroadcastChannel
// never delivers to the instance that posted, and the mutating hook already
// reconciles + refetches itself. Other devices still catch up via the poll.)
type StoreChangeKind = 'entries' | 'workspaces';
let storeBC: BroadcastChannel | null = null;
function storeChannel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return null;
  if (!storeBC) storeBC = new BroadcastChannel('tqv.store.v1');
  return storeBC;
}
function broadcastStoreChange(kind: StoreChangeKind): void {
  try {
    storeChannel()?.postMessage(kind);
  } catch {
    /* ignore — freshness falls back to the regular poll */
  }
}

/**
 * The window the shared poll keeps fresh: from the week's start (Saturday —
 * needed for the weekly model and so the leading weekend's entries load) but
 * never later than the start of yesterday, so unreported-time detection always
 * has both yesterday and today even on the first day of the week; through the
 * end of this week so pre-entered ("scheduled") future entries are included.
 * Exported so the tracker can load history seamlessly up to this window's edge.
 */
export function pollWindow(now: Date): { startMs: number; endMs: number } {
  const weekStart = startOfWeek(now).getTime();
  const yesterdayStart = startOfDay(now).getTime() - 24 * 3600 * 1000;
  return { startMs: Math.min(weekStart, yesterdayStart), endMs: weekStart + 7 * 24 * 3600 * 1000 };
}

/** Apply an EntryInput patch onto a client-side TimeEntry (optimistic preview). */
function patchEntry(e: TimeEntry, patch: EntryInput): TimeEntry {
  const next: TimeEntry = { ...e };
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.tags !== undefined) next.tags = patch.tags;
  if (patch.workspaceId !== undefined) next.project_id = patch.workspaceId;
  if (patch.start !== undefined) next.start = patch.start;
  if (patch.stop !== undefined) next.stop = patch.stop;
  const startMs = Date.parse(next.start);
  next.duration = next.stop
    ? Math.max(1, Math.round((Date.parse(next.stop) - startMs) / 1000))
    : -Math.floor(startMs / 1000);
  return next;
}

export interface UseTrackSource {
  hydrated: boolean;
  /** Which backend this deployment serves; null until /api/config resolves. */
  mode: SourceMode | null;
  settings: StoredSettings;
  setSettings: React.Dispatch<React.SetStateAction<StoredSettings>>;
  persist: (s: StoredSettings) => void;
  projects: TrackProject[];
  serverManaged: boolean | null;
  passwordRequired: boolean;
  authed: boolean;
  pwError: string | null;
  pwBusy: boolean;
  submitPassword: (password: string) => Promise<void>;
  ready: boolean;
  connecting: boolean;
  authError: string | null;
  fetchError: string | null;
  connect: (token: string, force?: boolean) => Promise<void>;
  entries: TimeEntry[];
  /**
   * When the entries on screen were produced by the SOURCE (ms epoch; 0 = no
   * successful fetch yet). This is the source-reported data time, not the
   * receipt time: a shared-server-cache hit carries the original upstream
   * Toggl fetch time, so the pages show true data age. Stays put while
   * fetches fail or the tab sleeps.
   */
  lastUpdatedMs: number;
  nowMs: number;
  reqThisHour: number;
  cacheEnabled: boolean;
  effectiveRefreshSec: number;
  showSettings: boolean;
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
  // Pause the live current-week poll (e.g. while viewing a historical week, so
  // we don't keep spending the budget on data that isn't on screen).
  livePollPaused: boolean;
  setLivePollPaused: React.Dispatch<React.SetStateAction<boolean>>;
  // General on-demand fetch of any date range as raw entries — the primitive
  // behind the historical timesheet (and, later, the weekly/monthly exports).
  // Forced fetches bypass the shared server cache; budget is metered the same
  // way the live poll is (skipped when a plain cache hit is expected). Resolves
  // the entries together with the source-reported data time (see FetchedEntries).
  loadRange: (startISO: string, endISO: string, opts?: { force?: boolean }) => Promise<FetchedEntries>;

  /**
   * Remember the export dialog's identity fields (company, client, rate,
   * engagement note …). They are scoped to the workspace the settings currently
   * mirror: the write lands both in the active settings and in that stored
   * workspace, so switching away and back keeps each workspace's own details.
   */
  setExportFields: (fields: ExportFieldValues) => void;
  /**
   * The stored workspace the current settings mirror — a store document in
   * standalone mode (its numeric id as a string), a saved preset in Toggl mode
   * — or null when they match none; per-workspace state, like the export
   * fields above, is then simply this device's.
   */
  activeWorkspace: { id: string; name: string } | null;

  // ---- Cross-device settings sync (see lib/sync) ----
  sync: {
    /** Whether the deployment has a sync store (MONGODB_URI + APP_PASSWORD). */
    enabled: boolean;
    /** Sync-specific deployment problem the operator must fix, or null. */
    misconfigured: string | null;
    /** Sync is enabled but this device hasn't passed the password gate yet
     * (only reachable in browser-token Toggl mode, where no page-level gate
     * shows — the Settings panel offers the password form instead). */
    needsAuth: boolean;
    status: 'idle' | 'syncing' | 'error';
    error: string | null;
    /** Last successful contact with the sync store (ms epoch; null = none). */
    lastSyncedAt: number | null;
    /** Both sides changed since the last sync — the user picks a winner. */
    conflict: { rev: number; updatedAt: string; device: string } | null;
    /**
     * How many times a document from ANOTHER device has replaced these
     * settings (a background pull that adopted it, or a conflict resolved in
     * its favour). Any UI holding a mount-time snapshot of the settings — the
     * Settings form, the export dialog — should key on this so it re-seeds
     * instead of writing its stale copy back on the next save.
     */
    appliedEpoch: number;
    resolveConflict: (choice: 'remote' | 'local') => void;
    /** Download the syncable settings as a JSON file (never the token). */
    exportFile: () => void;
    /** Apply a settings file; resolves an error message or null on success. */
    importFile: (file: File) => Promise<string | null>;
  };

  // ---- Standalone mode only (no-ops / empty elsewhere) ----
  /** Stored workspaces with their settings snapshots (the Settings section). */
  workspaces: StoreWorkspace[];
  /** Ask the live poll to fetch immediately (after an external mutation). */
  refetchEntries: () => void;
  /** Last failed mutation, for a toast; cleared via clearMutationError. */
  mutationError: string | null;
  clearMutationError: () => void;
  // Entry mutations (tracker UI). All optimistic against `entries`, reconciled
  // with the canonical server response; they resolve null on failure (the error
  // lands in mutationError, or the password gate re-arms on an expired session).
  startTimer: (input: {
    description: string;
    tags: string[];
    workspaceId: number;
  }) => Promise<TimeEntry | null>;
  addEntry: (input: {
    description: string;
    tags: string[];
    workspaceId: number;
    start: string;
    stop: string;
  }) => Promise<TimeEntry | null>;
  editEntry: (id: number, patch: EntryInput) => Promise<TimeEntry | null>;
  removeEntry: (id: number) => Promise<boolean>;
  stopTimer: (id: number) => Promise<TimeEntry | null>;
  // Workspace CRUD (Settings; the importer also creates). Each refreshes the
  // workspace/project lists.
  createWorkspace: (
    name: string,
    settings?: PresetValue,
    color?: string
  ) => Promise<StoreWorkspace | null>;
  updateWorkspace: (
    id: number,
    patch: { name?: string; color?: string; settings?: PresetValue }
  ) => Promise<StoreWorkspace | null>;
  deleteWorkspace: (id: number, force?: boolean) => Promise<'ok' | 'has-entries' | null>;
}

export function useTrackSource(): UseTrackSource {
  const [mode, setMode] = useState<SourceMode | null>(null);
  // Until config resolves, mode is unknown; the connect effect waits for it, so
  // the provisional Toggl backend here is never actually used prematurely.
  const backend = mode === 'standalone' ? standaloneBackend : togglBackend;
  const metered = backend.hourlyRequestLimit !== null;

  const [settings, setSettings] = useState<StoredSettings>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  const [projects, setProjects] = useState<TrackProject[]>([]);
  const [workspaces, setWorkspaces] = useState<StoreWorkspace[]>([]);
  const [serverManaged, setServerManaged] = useState<boolean | null>(null); // null = unknown
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [misconfigured, setMisconfigured] = useState<string | null>(null);
  const [authed, setAuthed] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [serverCache, setServerCache] = useState<{ enabled: boolean; intervalSec: number | null }>(
    { enabled: false, intervalSec: null }
  );
  const [ready, setReady] = useState(false); // token verified + workspace known
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncMisconfig, setSyncMisconfig] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle');
  const [syncErrorMsg, setSyncErrorMsg] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState<SyncDoc | null>(null);
  // Counts documents adopted from another device (see applyRemoteDoc).
  const [appliedEpoch, setAppliedEpoch] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // The initial pull must finish before any push: a fresh device that pushed
  // first (baseRev null) would race the established document into a conflict.
  const [syncReady, setSyncReady] = useState(false);
  // Bumped after a successful pull so the push effect re-evaluates whether the
  // syncable content drifted (e.g. a push that failed while offline).
  const [syncTick, setSyncTick] = useState(0);

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [lastUpdatedMs, setLastUpdatedMs] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const [reqThisHour, setReqThisHour] = useState(0);
  const [livePollPaused, setLivePollPaused] = useState(false);

  const lastFetchRef = useRef(0);
  const backoffUntilRef = useRef(0);
  const backoffStepRef = useRef(0);
  const refetchRef = useRef<(() => void) | null>(null);
  // Latest refreshWorkspaces, for the cross-tab listener (defined above it).
  const refreshWorkspacesRef = useRef<(() => Promise<StoreWorkspace[]>) | null>(null);
  const entriesRef = useRef<TimeEntry[]>([]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);
  // Latest settings, for async sync callbacks (pull/conflict resolution).
  const settingsRef = useRef<StoredSettings>(DEFAULTS);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const lastPullRef = useRef(0);

  // Hydrate from localStorage after mount (avoids SSR/client mismatch) and
  // find out which mode the server runs / whether it already holds a token.
  useEffect(() => {
    setSettings(loadSettings());
    setNowMs(Date.now());
    setReqThisHour(pruneLoad().length);
    setAuthed(hasValidAuth());
    setHydrated(true);
    getConfig()
      .then((c) => {
        setMode(c.mode);
        // Standalone deployments are always server-managed — there is no
        // browser credential; the store sits behind the password gate.
        setServerManaged(c.mode === 'standalone' ? true : !!c.serverToken);
        setPasswordRequired(!!c.passwordRequired);
        setMisconfigured(c.misconfigured ?? null);
        setServerCache(c.cache ?? { enabled: false, intervalSec: null });
        setSyncEnabled(c.sync?.enabled ?? false);
        setSyncMisconfig(c.sync?.misconfigured ?? null);
      })
      .catch(() => {
        setMode('toggl');
        setServerManaged(false);
      });
  }, []);

  // When the shared server cache is on, its interval governs polling and the
  // per-device refresh picker is hidden (the server owns the budget). The
  // standalone store polls at a fixed brisk cadence — no budget to manage.
  const standalone = backend.mode === 'standalone';
  const cacheEnabled = !standalone && serverCache.enabled && !!serverCache.intervalSec;
  const effectiveRefreshSec = standalone
    ? STANDALONE_REFRESH_SEC
    : cacheEnabled
    ? serverCache.intervalSec!
    : settings.refreshSec;
  // Poll one second SLOWER than the cache TTL so a client's poll reliably lands
  // just after the entry has expired (a guaranteed miss → fresh data).
  const pollIntervalSec = standalone
    ? STANDALONE_REFRESH_SEC
    : cacheEnabled
    ? serverCache.intervalSec! + 1
    : settings.refreshSec;

  // 1s tick drives the live clock and lets the request meter decay.
  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
      setReqThisHour(pruneLoad().length);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  const persist = useCallback((s: StoredSettings) => {
    setSettings(s);
    try {
      window.localStorage.setItem(LS_KEY, JSON.stringify(s));
    } catch {
      /* ignore quota / private-mode errors */
    }
  }, []);

  // Exchange the entered password for a session token, then let the connect
  // effect proceed. The password is never stored — only the returned token is.
  const submitPassword = useCallback(async (password: string) => {
    setPwBusy(true);
    setPwError(null);
    try {
      await login(password);
      setAuthed(true);
    } catch (e) {
      setPwError(
        isRateLimit(e) ? 'Too many attempts — wait a moment and try again.' : 'Incorrect password.'
      );
    } finally {
      setPwBusy(false);
    }
  }, []);

  // Verify credentials, resolve the workspace/project list. Toggl mode uses the
  // 24h cache unless forced (e.g. the user clicks Connect/Reconnect), to
  // conserve requests; standalone always fetches live (unmetered, and the list
  // changes right here in Settings).
  const connect = useCallback(
    async (token: string, force = false) => {
      setConnecting(true);
      setAuthError(null);
      try {
        if (standalone) {
          const ws = await listWorkspaces();
          setWorkspaces(ws);
          const projs = workspacesToProjects(ws);
          setProjects(projs);
          setSettings((prev) => ({
            ...prev,
            token: '',
            workspaceId: 1,
            selectedProjects: enrichSelected(prev.selectedProjects, projs),
          }));
          setReady(true);
          return;
        }
        if (!force) {
          const c = loadCache();
          if (c && c.projects?.length && Date.now() - c.at < CACHE_TTL) {
            setProjects(c.projects);
            setSettings((prev) => ({
              ...prev,
              token,
              workspaceId: c.workspaceId,
              accountName: c.accountName ?? prev.accountName,
              selectedProjects: enrichSelected(prev.selectedProjects, c.projects),
            }));
            setReady(true);
            return;
          }
        }
        if (metered) setReqThisHour(recordReqs(2)); // me + projects
        const info = await backend.connect(token);
        setProjects(info.projects);
        setSettings((prev) => ({
          ...prev,
          token,
          workspaceId: info.workspaceId,
          accountName: info.accountName || prev.accountName,
          selectedProjects: enrichSelected(prev.selectedProjects, info.projects),
        }));
        saveCache({
          workspaceId: info.workspaceId,
          projects: info.projects,
          accountName: info.accountName,
          at: Date.now(),
        });
        setReady(true);
      } catch (e) {
        setReady(false);
        setProjects([]);
        // Session missing/expired (or password rotated): drop back to the gate
        // instead of showing a source auth error.
        if (isAuthRequired(e)) {
          setAuthed(false);
          return;
        }
        setAuthError(
          isRateLimit(e)
            ? 'Toggl rate limit reached — wait a bit, then try again.'
            : standalone
            ? `Could not reach the store — check MONGODB_URI and the database's network access.${
                errorDetail(e) ? ` (${errorDetail(e)})` : ''
              }`
            : serverManaged
            ? 'The server-configured Toggl token was rejected. Check TOGGL_API_TOKEN.'
            : 'Could not authenticate with Toggl. Check your API token.'
        );
        setShowSettings(true);
      } finally {
        setConnecting(false);
      }
    },
    [backend, metered, serverManaged, standalone]
  );

  // Once we know the server-token status, connect appropriately (cache-first).
  useEffect(() => {
    if (!hydrated || serverManaged === null || ready) return;
    // A misconfigured deployment (standalone without APP_PASSWORD) can't serve
    // anything — surface the problem instead of a doomed connect.
    if (misconfigured) {
      setAuthError(misconfigured);
      setShowSettings(true);
      return;
    }
    if (serverManaged) {
      // When a password gate is active, wait until we hold a session before
      // connecting — the proxy would reject the fetch anyway.
      if (passwordRequired && !authed) return;
      connect(''); // server holds the credential; ignore any stored browser token
    } else if (settings.token) {
      connect(settings.token);
    } else {
      setShowSettings(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, serverManaged, passwordRequired, authed, misconfigured]);

  // Poll time entries. A single request (the entries list already includes the
  // running timer). Self-scheduling so we can pause while the tab is hidden and
  // back off on rate limits; the live counter ticks locally in between.
  useEffect(() => {
    if (!ready || livePollPaused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const intervalMs = Math.max(30, pollIntervalSec) * 1000;

    const fetchNow = async () => {
      lastFetchRef.current = Date.now();
      // In cache mode this device's poll is usually a server cache hit (no
      // upstream call), so the per-device hourly meter would over-count — skip it.
      if (metered && !cacheEnabled) setReqThisHour(recordReqs(1));
      try {
        const win = pollWindow(new Date());
        const { entries: ent, dataAtMs } = await backend.fetchEntries(
          settings.token,
          new Date(win.startMs).toISOString(),
          new Date(win.endMs).toISOString()
        );
        if (cancelled) return;
        setEntries(ent ?? []);
        setLastUpdatedMs(dataAtMs ?? Date.now());
        setFetchError(null);
        backoffStepRef.current = 0;
        backoffUntilRef.current = 0;
      } catch (e) {
        if (cancelled) return;
        if (isAuthRequired(e)) {
          // Session expired mid-session — fall back to the password gate.
          setReady(false);
          setAuthed(false);
          return;
        }
        if (isRateLimit(e)) {
          backoffStepRef.current = Math.min(backoffStepRef.current + 1, 5);
          const wait = Math.min(intervalMs * 2 ** backoffStepRef.current, 15 * 60_000);
          backoffUntilRef.current = Date.now() + wait;
          setFetchError('Rate limited by Toggl — slowing down automatically.');
        } else {
          setFetchError('Failed to refresh data.');
        }
      }
    };
    // Let mutations request an immediate canonical refresh out of band.
    refetchRef.current = () => {
      fetchNow();
    };

    const tick = async () => {
      if (cancelled) return;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (hidden) {
        timer = setTimeout(tick, 5000); // re-check soon; no network while hidden
        return;
      }
      const now = Date.now();
      const dueAt = Math.max(lastFetchRef.current + intervalMs, backoffUntilRef.current);
      if (now < dueAt) {
        timer = setTimeout(tick, Math.max(1000, dueAt - now));
        return;
      }
      await fetchNow();
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        tick();
      }
    };

    tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      refetchRef.current = null;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, livePollPaused, settings.token, pollIntervalSec, cacheEnabled, backend, metered]);

  // On-demand fetch of an arbitrary range (historical timesheet; future exports).
  // A plain (unforced) fetch in shared-cache mode is normally a server cache hit,
  // so — like the live poll — it isn't charged to the per-device meter; a forced
  // refresh always hits the source, so it is. AuthRequired bubbles up so the
  // caller can re-gate; other errors surface as thrown ApiErrors.
  const loadRange = useCallback(
    async (startISO: string, endISO: string, opts?: { force?: boolean }): Promise<FetchedEntries> => {
      const force = opts?.force === true;
      if (metered && (!cacheEnabled || force)) setReqThisHour(recordReqs(1));
      const { entries: ent, dataAtMs } = await backend.fetchEntries(settings.token, startISO, endISO, {
        force,
      });
      return { entries: ent ?? [], dataAtMs };
    },
    [backend, metered, cacheEnabled, settings.token]
  );

  const refetchEntries = useCallback(() => {
    refetchRef.current?.();
  }, []);
  const clearMutationError = useCallback(() => setMutationError(null), []);

  // React to store changes made in OTHER tabs/windows: refetch entries at
  // once (and re-list workspaces when those changed) instead of waiting out
  // the poll interval on stale data.
  useEffect(() => {
    if (!standalone || !ready) return;
    const ch = storeChannel();
    if (!ch) return;
    const onMessage = (e: MessageEvent) => {
      if (e.data === 'workspaces') refreshWorkspacesRef.current?.();
      refetchRef.current?.();
    };
    ch.addEventListener('message', onMessage);
    return () => ch.removeEventListener('message', onMessage);
  }, [standalone, ready]);

  // Standalone workspaces live in their own collection, outside the sync
  // payload — so a rename, recapture, create or delete made on ANOTHER device
  // reaches this one through neither the settings pull nor the (same-browser)
  // BroadcastChannel. Re-list them when the window regains focus, throttled the
  // way the sync pull is. Without this a recall could reapply an obsolete
  // snapshot, and an export-detail write would be built on one (see
  // setExportFields, which patches the workspace's cached settings).
  const lastWsListRef = useRef(0);
  useEffect(() => {
    if (!standalone || !ready) return;
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastWsListRef.current < 30_000) return;
      lastWsListRef.current = Date.now();
      refreshWorkspacesRef.current?.().catch(() => {
        /* transient — the next focus (or any mutation) tries again */
      });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [standalone, ready]);

  // ---- Cross-device settings sync ----
  // Engine: pull on load and on window focus; push (debounced) whenever the
  // syncable content differs from what this device last synced. Every decision
  // goes through the content hash stored in the sync bookmark (tqv.sync.v1),
  // so identical content never generates traffic and applying a pulled
  // document never echoes back as a push. Conflicts (both sides changed since
  // the last common revision) are never auto-resolved — the newer document is
  // parked in `syncConflict` and the Settings panel asks the user to pick.
  const syncActive = syncEnabled && hydrated && (!passwordRequired || authed);

  const applyRemoteDoc = useCallback(
    (doc: SyncDoc) => {
      saveSyncMeta({ rev: doc.rev, hash: payloadHash(doc.payload) });
      persist(applySyncPayload(settingsRef.current, doc.payload));
      setSyncConflict(null);
      setLastSyncedAt(Date.now());
      // Surfaces that another device's document replaced these settings — the
      // Settings form and the export dialog both hold mount-time snapshots and
      // must re-seed, or the next Save/Export would write the stale values
      // back over what was just adopted (and push them at the NEW revision, so
      // not even a conflict would catch it).
      setAppliedEpoch((n) => n + 1);
    },
    [persist]
  );

  const pullSync = useCallback(async () => {
    lastPullRef.current = Date.now();
    try {
      const doc = await fetchSyncDoc();
      const meta = loadSyncMeta();
      if (doc && (!meta || doc.rev > meta.rev)) {
        // The server moved past this device. Adopt it unless this device has
        // unsynced changes of its own — then hold both and let the user pick.
        const localHash = payloadHash(buildSyncPayload(settingsRef.current));
        const unchanged = meta
          ? meta.hash === localHash
          : localHash === pristineHash(settingsRef.current);
        if (unchanged) applyRemoteDoc(doc);
        else setSyncConflict(doc);
      } else {
        setLastSyncedAt(Date.now());
      }
      setSyncStatus('idle');
      setSyncErrorMsg(null);
      setSyncReady(true);
      // Re-evaluate the push effect: local drift (or a push that failed while
      // offline) gets uploaded now that the store is reachable again.
      setSyncTick((t) => t + 1);
    } catch (e) {
      if (isAuthRequired(e)) {
        setAuthed(false);
        return;
      }
      setSyncStatus('error');
      setSyncErrorMsg(
        `Could not reach the sync store.${errorDetail(e) ? ` (${errorDetail(e)})` : ''}`
      );
    }
  }, [applyRemoteDoc]);

  // Pull on activation, then again whenever the window regains focus (another
  // device may have synced meanwhile) — throttled so tab-switching is free.
  useEffect(() => {
    if (!syncActive) return;
    pullSync();
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastPullRef.current < 30_000) return;
      pullSync();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [syncActive, pullSync]);

  // Debounced push of local changes.
  useEffect(() => {
    if (!syncActive || !syncReady || syncConflict) return;
    const payload = buildSyncPayload(settings);
    const hash = payloadHash(payload);
    const meta = loadSyncMeta();
    if (meta?.hash === hash) return;
    // A never-configured device that has never synced has nothing worth
    // creating the server document for — and letting it push would make the
    // user's REAL device raise a conflict over a document full of defaults
    // if the fresh one merely loaded first.
    if (!meta && hash === pristineHash(settings)) return;
    const timer = setTimeout(async () => {
      setSyncStatus('syncing');
      try {
        const info = await pushSyncDoc(meta?.rev ?? null, payload, deviceLabel());
        saveSyncMeta({ rev: info.rev, hash });
        setSyncStatus('idle');
        setSyncErrorMsg(null);
        setLastSyncedAt(Date.now());
      } catch (e) {
        if (e instanceof SyncConflictError) {
          setSyncStatus('idle');
          setSyncConflict(e.doc);
          return;
        }
        if (isAuthRequired(e)) {
          setAuthed(false);
          return;
        }
        setSyncStatus('error');
        setSyncErrorMsg('Could not save settings to the sync store.');
      }
    }, 1500);
    return () => clearTimeout(timer);
    // syncTick re-runs this after successful pulls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, syncTick, syncActive, syncReady, syncConflict]);

  const resolveSyncConflict = useCallback(
    async (choice: 'remote' | 'local') => {
      const doc = syncConflict;
      if (!doc) return;
      if (choice === 'remote') {
        applyRemoteDoc(doc);
        return;
      }
      // Keep this device: overwrite the server's revision explicitly.
      setSyncStatus('syncing');
      try {
        const payload = buildSyncPayload(settingsRef.current);
        const info = await pushSyncDoc(doc.rev, payload, deviceLabel());
        saveSyncMeta({ rev: info.rev, hash: payloadHash(payload) });
        setSyncConflict(null);
        setSyncStatus('idle');
        setSyncErrorMsg(null);
        setLastSyncedAt(Date.now());
      } catch (e) {
        if (e instanceof SyncConflictError) {
          // Another device raced in between — re-offer with the newest copy.
          setSyncStatus('idle');
          setSyncConflict(e.doc);
          return;
        }
        if (isAuthRequired(e)) {
          setAuthed(false);
          return;
        }
        setSyncStatus('error');
        setSyncErrorMsg('Could not save settings to the sync store.');
      }
    },
    [syncConflict, applyRemoteDoc]
  );

  // Manual transfer: the same payload sync moves, as a downloadable file —
  // the zero-infrastructure path for deployments without a sync store.
  const exportSettingsFile = useCallback(() => {
    const payload = buildSyncPayload(settingsRef.current);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'toggl-quick-view-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importSettingsFile = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const parsed = JSON.parse(await file.text()) as SyncPayload;
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          parsed.v !== SYNC_PAYLOAD_VERSION ||
          !parsed.settings ||
          typeof parsed.settings !== 'object'
        ) {
          return 'Not a settings file exported by this app.';
        }
        persist(applySyncPayload(settingsRef.current, parsed));
        return null;
      } catch {
        return 'Could not read that file.';
      }
    },
    [persist]
  );

  // ---- Standalone mutations ----
  // Shared shape: apply the optimistic change to the entries state, run the
  // server call, reconcile with the canonical result, and kick an instant poll
  // so any side effects (e.g. the previously running entry a new timer closed)
  // turn canonical too. On failure everything rolls back and the error surfaces
  // as a toastable message. Resolves null (or false) on failure.
  const runMutation = useCallback(
    async <R,>(
      optimistic: (list: TimeEntry[]) => TimeEntry[],
      run: () => Promise<R>,
      reconcile: ((result: R, list: TimeEntry[]) => TimeEntry[]) | null,
      failMessage: string
    ): Promise<R | null> => {
      const snapshot = entriesRef.current;
      setEntries(optimistic);
      try {
        const result = await run();
        if (reconcile) setEntries((list) => reconcile(result, list));
        refetchRef.current?.();
        broadcastStoreChange('entries');
        return result;
      } catch (e) {
        setEntries(snapshot);
        if (isAuthRequired(e)) {
          setReady(false);
          setAuthed(false);
        } else {
          const detail = errorDetail(e);
          setMutationError(detail ? `${failMessage} (${detail})` : failMessage);
        }
        return null;
      }
    },
    []
  );

  const isRunning = (e: TimeEntry) => e.duration < 0 || !e.stop;

  const startTimer = useCallback<UseTrackSource['startTimer']>(
    async ({ description, tags, workspaceId }) => {
      const start = new Date().toISOString();
      const startMs = Date.parse(start);
      const temp: TimeEntry = {
        id: -startMs, // provisional; swapped for the canonical id on response
        start,
        stop: null,
        duration: -Math.floor(startMs / 1000),
        project_id: workspaceId,
        workspace_id: 1,
        description,
        tags,
      };
      return runMutation(
        (list) => [
          ...list.map((e) =>
            isRunning(e) ? patchEntry(e, { stop: start }) : e
          ),
          temp,
        ],
        () => createEntryApi({ description, workspaceId, tags, start, stop: null }),
        (created, list) => list.map((e) => (e.id === temp.id ? created : e)),
        'Could not start the timer.'
      );
    },
    [runMutation]
  );

  const addEntry = useCallback<UseTrackSource['addEntry']>(
    async ({ description, tags, workspaceId, start, stop }) => {
      // Only surface the optimistic copy in the shared poll state when it falls
      // inside the poll's window; a backdated entry belongs to the tracker's
      // own history list, which reconciles from the returned canonical entry.
      const inWindow = Date.parse(start) >= pollWindow(new Date()).startMs;
      const temp: TimeEntry = patchEntry(
        {
          id: -Date.parse(start) - 1,
          start,
          stop,
          duration: 0,
          project_id: workspaceId,
          workspace_id: 1,
          description,
          tags,
        },
        {}
      );
      return runMutation(
        (list) => (inWindow ? [...list, temp] : list),
        () => createEntryApi({ description, workspaceId, tags, start, stop }),
        (created, list) =>
          inWindow ? list.map((e) => (e.id === temp.id ? created : e)) : list,
        'Could not add the entry.'
      );
    },
    [runMutation]
  );

  const editEntry = useCallback<UseTrackSource['editEntry']>(
    (id, patch) =>
      runMutation(
        (list) => list.map((e) => (e.id === id ? patchEntry(e, patch) : e)),
        () => updateEntryApi(id, patch),
        (canon, list) => list.map((e) => (e.id === id ? canon : e)),
        'Could not save the change.'
      ),
    [runMutation]
  );

  const removeEntry = useCallback<UseTrackSource['removeEntry']>(
    async (id) => {
      const res = await runMutation(
        (list) => list.filter((e) => e.id !== id),
        () => deleteEntryApi(id),
        null,
        'Could not delete the entry.'
      );
      return res !== null;
    },
    [runMutation]
  );

  const stopTimer = useCallback<UseTrackSource['stopTimer']>(
    (id) => {
      const stop = new Date().toISOString();
      return runMutation(
        (list) => list.map((e) => (e.id === id ? patchEntry(e, { stop }) : e)),
        () => stopEntryApi(id),
        (canon, list) => list.map((e) => (e.id === id ? canon : e)),
        'Could not stop the timer.'
      );
    },
    [runMutation]
  );

  // ---- Standalone workspace CRUD (Settings) ----
  // Every operation refreshes the workspace + project lists so the pickers and
  // chips reflect the change at once.
  const refreshWorkspaces = useCallback(async (): Promise<StoreWorkspace[]> => {
    const ws = await listWorkspaces();
    setWorkspaces(ws);
    const projs = workspacesToProjects(ws);
    setProjects(projs);
    setSettings((prev) => ({
      ...prev,
      selectedProjects: enrichSelected(prev.selectedProjects, projs),
    }));
    return ws;
  }, []);
  refreshWorkspacesRef.current = refreshWorkspaces;

  const workspaceOp = useCallback(
    async <R,>(run: () => Promise<R>, failMessage: string): Promise<R | null> => {
      try {
        const result = await run();
        await refreshWorkspaces();
        broadcastStoreChange('workspaces');
        return result;
      } catch (e) {
        if (isAuthRequired(e)) {
          setReady(false);
          setAuthed(false);
        } else {
          const detail = errorDetail(e);
          setMutationError(detail ? `${failMessage} (${detail})` : failMessage);
        }
        return null;
      }
    },
    [refreshWorkspaces]
  );

  const createWorkspace = useCallback<UseTrackSource['createWorkspace']>(
    (name, settingsSnapshot, color) =>
      workspaceOp(
        () => createWorkspaceApi(name, settingsSnapshot, color),
        'Could not create the workspace.'
      ),
    [workspaceOp]
  );

  const updateWorkspace = useCallback<UseTrackSource['updateWorkspace']>(
    (id, patch) =>
      workspaceOp(() => updateWorkspaceApi(id, patch), 'Could not update the workspace.'),
    [workspaceOp]
  );

  const deleteWorkspace = useCallback<UseTrackSource['deleteWorkspace']>(
    async (id, force = false) => {
      try {
        await deleteWorkspaceApi(id, force);
        // The server strips references out of the OTHER workspace documents;
        // this device's active settings may reference the deleted workspace
        // too (as a tracked selection or a linked billing code) — strip those
        // the same way so nothing keeps pointing at a workspace that's gone.
        setSettings((prev) => {
          const selectedProjects = prev.selectedProjects.filter((p) => p.id !== id);
          const codeMappings = (prev.codeMappings ?? []).filter((m) => m.projectId !== id);
          // The recalled-workspace pointer goes too when it named this one.
          const activePresetId =
            prev.activePresetId === String(id) ? null : prev.activePresetId;
          if (
            selectedProjects.length === prev.selectedProjects.length &&
            codeMappings.length === (prev.codeMappings ?? []).length &&
            activePresetId === prev.activePresetId
          ) {
            return prev;
          }
          const next = { ...prev, selectedProjects, codeMappings, activePresetId };
          try {
            window.localStorage.setItem(LS_KEY, JSON.stringify(next));
          } catch {
            /* ignore quota / private-mode errors */
          }
          return next;
        });
        await refreshWorkspaces();
        broadcastStoreChange('workspaces');
        return 'ok';
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return 'has-entries';
        if (isAuthRequired(e)) {
          setReady(false);
          setAuthed(false);
        } else {
          const detail = errorDetail(e);
          setMutationError(
            detail ? `Could not delete the workspace. (${detail})` : 'Could not delete the workspace.'
          );
        }
        return null;
      }
    },
    [refreshWorkspaces]
  );

  // ---- Export identity fields (the export dialog's remembered details) ----
  // They belong to the workspace being billed, so a write goes two places: the
  // active settings (what the next export starts from) and the stored workspace
  // those settings mirror, which is what makes the values survive a switch to
  // another workspace and back. With no workspace stored — or with the settings
  // no longer matching any — only the active settings are written, exactly as
  // the device-wide behaviour used to be.
  //
  // The store write is debounced: the engagement note saves as it is typed, and
  // a workspace document is a server round-trip.
  const workspacesRef = useRef<StoreWorkspace[]>([]);
  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  // The stored workspaces of whichever mode this is, in one shape (standalone:
  // server documents; Toggl: the localStorage preset list).
  const storedWorkspaces = useMemo(
    () =>
      standalone
        ? workspaces.map((w) => ({ id: String(w.id), name: w.name, value: w.settings }))
        : settings.presets.map((p) => ({ id: p.id, name: p.name, value: p.value })),
    [standalone, workspaces, settings.presets]
  );

  // Which one the settings currently mirror. Content decides whether ANY of
  // them is active; the recalled id then decides WHICH — two workspaces can be
  // identical apart from their export details, and presetMatches (rightly)
  // ignores those, so content alone could not tell them apart and a write
  // would land on both.
  const activeWorkspace = useMemo(() => {
    const matching = storedWorkspaces.filter((w) => presetMatches(w.value, settings));
    return matching.find((w) => w.id === settings.activePresetId) ?? matching[0] ?? null;
  }, [storedWorkspaces, settings]);

  const activeWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace?.id ?? null;
  }, [activeWorkspace]);

  const exportCommitRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The workspace to commit to is resolved when the write happens, not when the
  // timer fires — switching workspaces mid-note must not redirect the note.
  const exportPendingRef = useRef<{ workspaceId: number; fields: ExportFieldValues } | null>(null);

  // Send the pending workspace write. `beacon` is the page-is-going-away path:
  // it calls the API directly (nothing to reconcile into state that is about to
  // disappear) with keepalive, so the browser finishes the request after this
  // document is gone.
  const commitExportFields = useCallback(
    (pending: { workspaceId: number; fields: ExportFieldValues }, beacon = false) => {
      const ws = workspacesRef.current.find((w) => w.id === pending.workspaceId);
      if (!ws || exportFieldsEqual(ws.settings.exportFields, pending.fields)) return;
      const patch = { settings: { ...ws.settings, exportFields: pending.fields } };
      if (beacon) {
        void updateWorkspaceApi(ws.id, patch, { keepalive: true }).catch(() => {
          /* the value is already in the local settings; nothing to report to a
             page that is unloading */
        });
        return;
      }
      updateWorkspace(ws.id, patch);
    },
    [updateWorkspace]
  );

  // Send whatever is still queued, now. Used when the page is hidden, unloaded
  // or navigated away from — otherwise a note typed in the last 1.2s would
  // reach the local settings but never the workspace document, and another
  // device would never see it.
  const flushExportFields = useCallback(
    (beacon = false) => {
      if (exportCommitRef.current) {
        clearTimeout(exportCommitRef.current);
        exportCommitRef.current = null;
      }
      const pending = exportPendingRef.current;
      exportPendingRef.current = null;
      if (pending) commitExportFields(pending, beacon);
    },
    [commitExportFields]
  );

  const flushExportFieldsRef = useRef(flushExportFields);
  useEffect(() => {
    flushExportFieldsRef.current = flushExportFields;
  }, [flushExportFields]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === 'hidden') flushExportFieldsRef.current(true);
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
      // Leaving this page (a route change, or the tab closing without ever
      // going hidden) — the queued write goes out now rather than dying here.
      flushExportFieldsRef.current(true);
    };
  }, []);

  const setExportFields = useCallback<UseTrackSource['setExportFields']>(
    (fields) => {
      const value = normalizeExportFields(fields);
      const prev = settingsRef.current;
      if (exportFieldsEqual(prev.exportFields, value)) return;
      const activeId = activeWorkspaceRef.current;
      // Toggl mode: the stored workspaces are part of the settings, so the
      // active one — that one only, never a twin with the same tracking
      // settings — is updated in the same write.
      const presets = prev.presets.map((p) =>
        p.id === activeId ? { ...p, value: { ...p.value, exportFields: value } } : p
      );
      persist({ ...prev, exportFields: value, presets });
      if (!standalone || activeId === null) return;
      exportPendingRef.current = { workspaceId: Number(activeId), fields: value };
      if (exportCommitRef.current) clearTimeout(exportCommitRef.current);
      exportCommitRef.current = setTimeout(() => {
        exportCommitRef.current = null;
        const pending = exportPendingRef.current;
        exportPendingRef.current = null;
        if (pending) commitExportFields(pending);
      }, 1200);
    },
    [persist, standalone, commitExportFields]
  );

  return {
    hydrated,
    mode,
    settings,
    setSettings,
    persist,
    projects,
    serverManaged,
    passwordRequired,
    authed,
    pwError,
    pwBusy,
    submitPassword,
    ready,
    connecting,
    authError,
    fetchError,
    connect,
    entries,
    lastUpdatedMs,
    nowMs,
    reqThisHour,
    cacheEnabled,
    effectiveRefreshSec,
    showSettings,
    setShowSettings,
    livePollPaused,
    setLivePollPaused,
    loadRange,
    setExportFields,
    activeWorkspace: activeWorkspace ? { id: activeWorkspace.id, name: activeWorkspace.name } : null,
    sync: {
      enabled: syncEnabled,
      misconfigured: syncMisconfig,
      needsAuth: syncEnabled && passwordRequired && !authed,
      status: syncStatus,
      error: syncErrorMsg,
      lastSyncedAt,
      conflict: syncConflict
        ? { rev: syncConflict.rev, updatedAt: syncConflict.updatedAt, device: syncConflict.device }
        : null,
      appliedEpoch,
      resolveConflict: resolveSyncConflict,
      exportFile: exportSettingsFile,
      importFile: importSettingsFile,
    },
    workspaces,
    refetchEntries,
    mutationError,
    clearMutationError,
    startTimer,
    addEntry,
    editEntry,
    removeEntry,
    stopTimer,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
  };
}
