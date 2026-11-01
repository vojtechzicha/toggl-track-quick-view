'use client';

// Toggl connection and polling shared by the dashboard and timesheet pages:
// settings, server-managed / password-gate status, connecting (cache-first),
// and the poll that fetches the week's entries. All pages use this one hook
// so the request budget is spent once. Pages derive their own views from the
// raw entries.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getConfig } from '@/lib/source/config';
import { hasValidAuth, login } from '@/lib/source/auth';
import { errorDetail, isRateLimit, isAuthRequired } from '@/lib/source/errors';
import { togglBackend } from '@/lib/source/toggl';
import type { FetchedEntries, TrackProject } from '@/lib/source/types';
import { presetMatches } from '@/components/SettingsPanel';
import type {
  SettingsValue,
  SelectedProject,
  SettingsPreset,
  PresetValue,
} from '@/components/SettingsPanel';
import {
  TimeEntry,
  addDays,
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
const DEFAULT_REFRESH_SEC = 180; // 20 requests/hour, under Toggl's limit

export interface StoredSettings extends SettingsValue {
  workspaceId: number | null;
  // Account display name from connect time; the default name on exports.
  accountName: string;
  // Saved workspaces (named settings snapshots).
  presets: SettingsPreset[];
  // Id of the workspace last recalled. Tells apart two workspaces that differ only in export
  // details, which presetMatches ignores. Re-checked against the content
  // before use, so edited settings stop writing into that workspace.
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
  billByProject: false,
  stripCodeParens: false,
  timeOffTag: DEFAULT_TIME_OFF_TAG,
  roundingHours: DEFAULT_ROUNDING_HOURS,
  startWindowHours: null,
  maxDescriptionLength: null,
  noOvertime: false,
  balanceWeekdays: false,
  codeMappings: [],
  refreshSec: DEFAULT_REFRESH_SEC,
  timesheetMode: 'summary',
  exportName: '',
  exportFields: EMPTY_EXPORT_FIELDS,
  presets: [],
  activePresetId: null,
};

/**
 * Apply a stored workspace over the current settings. Refreshes each recalled
 * project's name/color from the live project list; leaves the token, workspace
 * and stored-workspace list alone.
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
    // Presets saved before a setting existed lack its key. Without these
    // defaults the current value would leak into the recalled workspace.
    codeMappings: preset.value.codeMappings ?? [],
    maxDescriptionLength: preset.value.maxDescriptionLength ?? null,
    startWindowHours: preset.value.startWindowHours ?? null,
    timeOffTag: preset.value.timeOffTag ?? DEFAULT_TIME_OFF_TAG,
    stripCodeParens: preset.value.stripCodeParens ?? false,
    billByProject: preset.value.billByProject ?? false,
    balanceWeekdays: preset.value.balanceWeekdays ?? false,
    // Export fields are per workspace, so one client's details never carry
    // over to another. A workspace saved before they were scoped has none and
    // inherits the current ones. One that has them keeps them, even if empty.
    exportFields: preset.value.exportFields
      ? normalizeExportFields(preset.value.exportFields)
      : normalizeExportFields(settings.exportFields),
    // So later export-field writes reach this workspace, not a twin with the
    // same tracking settings.
    activePresetId: preset.id,
  };
}

/**
 * Hash of a never-configured device: defaults plus the connect-derived
 * workspace/account. A fresh device matching it adopts the synced setup
 * without a conflict banner.
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
    // Run the migrations even with no settings: the legacy export-field keys
    // can outlive a cleared settings entry.
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    // Migrate the v1 single-project shape ({ projectId, projectName }).
    if (!parsed.selectedProjects && parsed.projectId != null) {
      parsed.selectedProjects = [
        { id: parsed.projectId, name: (parsed.projectName as string) ?? '' },
      ];
    }
    delete parsed.projectId;
    delete parsed.projectName;
    const loaded = { ...DEFAULTS, ...parsed } as StoredSettings;
    // Fold the legacy device-wide export-field keys in once.
    if (!parsed.exportFields) {
      const legacy = readLegacyExportFields();
      if (legacy) {
        loaded.exportFields = legacy;
        // Persist before deleting the old keys, or a failed write loses them.
        try {
          window.localStorage.setItem(LS_KEY, JSON.stringify(loaded));
          clearLegacyExportFields();
        } catch {
          /* private mode / quota: old keys stay, migrate again next load */
        }
      }
    }
    loaded.exportFields = normalizeExportFields(loaded.exportFields);
    return loaded;
  } catch {
    return DEFAULTS;
  }
}

// ---- me/projects cache (saves request budget on reload) ----
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
 * Refresh each selected project's stored name/color from the loaded list.
 * Unknown ids (e.g. archived projects) keep their stored copy.
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

// ---- rolling 60-minute request log (an estimate, for the budget meter) ----
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

/**
 * The range the poll keeps fresh. Starts at the week's start (Saturday) or
 * the start of yesterday, whichever is earlier, so unreported-time detection
 * always sees yesterday. Ends at the end of this week to include future
 * ("scheduled") entries. The tracker loads older history up to this edge.
 */
export function pollWindow(now: Date): { startMs: number; endMs: number } {
  const weekStart = startOfWeek(now).getTime();
  const yesterdayStart = addDays(startOfDay(now).getTime(), -1);
  return { startMs: Math.min(weekStart, yesterdayStart), endMs: addDays(weekStart, 7) };
}

export interface UseTrackSource {
  hydrated: boolean;
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
   * Source-reported data time of the entries (ms epoch; 0 = no fetch yet).
   * A server-cache hit carries the original Toggl fetch time, so this is the
   * real data age, not receipt time. Unchanged while fetches fail.
   */
  lastUpdatedMs: number;
  nowMs: number;
  reqThisHour: number;
  cacheEnabled: boolean;
  effectiveRefreshSec: number;
  showSettings: boolean;
  setShowSettings: React.Dispatch<React.SetStateAction<boolean>>;
  // Pause the current-week poll, e.g. while a past week is on screen.
  livePollPaused: boolean;
  setLivePollPaused: React.Dispatch<React.SetStateAction<boolean>>;
  // On-demand fetch of any date range (historical timesheet, exports). Forced
  // fetches bypass the server cache. Metered like the live poll.
  loadRange: (startISO: string, endISO: string, opts?: { force?: boolean }) => Promise<FetchedEntries>;

  /**
   * Save the export dialog's identity fields (company, client, rate, ...) to
   * the active settings and to the active workspace, if any.
   */
  setExportFields: (fields: ExportFieldValues) => void;
  /** The stored workspace (preset) the current settings match, or null. */
  activeWorkspace: { id: string; name: string } | null;
  /** All stored workspaces, for the quick switcher. */
  workspaceList: { id: string; name: string; value: PresetValue }[];
  /** Recall a stored workspace by id. Unknown ids are ignored. */
  switchWorkspace: (id: string) => void;

  // ---- Cross-device settings sync (see lib/sync) ----
  sync: {
    /** Whether the deployment has a sync store (MONGODB_URI + APP_PASSWORD). */
    enabled: boolean;
    /** Sync-specific deployment problem the operator must fix, or null. */
    misconfigured: string | null;
    /** Sync is on but this device has no session. Only in browser-token Toggl
     * mode, where Settings shows the password form instead of a page gate. */
    needsAuth: boolean;
    status: 'idle' | 'syncing' | 'error';
    error: string | null;
    /** Last successful contact with the sync store (ms epoch; null = none). */
    lastSyncedAt: number | null;
    /** Both sides changed since the last sync — the user picks a winner. */
    conflict: { rev: number; updatedAt: string; device: string } | null;
    /**
     * Count of times another device's document replaced these settings. UI
     * that snapshots settings on mount (Settings form, export dialog) should
     * key on it, or it writes a stale copy back on its next save.
     */
    appliedEpoch: number;
    resolveConflict: (choice: 'remote' | 'local') => void;
    /** Download the syncable settings as a JSON file (never the token). */
    exportFile: () => void;
    /** Apply a settings file; resolves an error message or null on success. */
    importFile: (file: File) => Promise<string | null>;
  };
}

export function useTrackSource(): UseTrackSource {
  const backend = togglBackend;
  const metered = backend.hourlyRequestLimit !== null;

  const [settings, setSettings] = useState<StoredSettings>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  const [projects, setProjects] = useState<TrackProject[]>([]);
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
  const [showSettings, setShowSettings] = useState(false);

  const [syncEnabled, setSyncEnabled] = useState(false);
  const [syncMisconfig, setSyncMisconfig] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'error'>('idle');
  const [syncErrorMsg, setSyncErrorMsg] = useState<string | null>(null);
  const [syncConflict, setSyncConflict] = useState<SyncDoc | null>(null);
  // Counts documents adopted from another device (see applyRemoteDoc).
  const [appliedEpoch, setAppliedEpoch] = useState(0);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  // The initial pull must finish before any push, or a fresh device (baseRev
  // null) would conflict with the existing document.
  const [syncReady, setSyncReady] = useState(false);
  // Bumped after each pull so the push effect retries content that drifted
  // (e.g. a push that failed offline).
  const [syncTick, setSyncTick] = useState(0);

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [lastUpdatedMs, setLastUpdatedMs] = useState(0);
  const [nowMs, setNowMs] = useState(0);
  const [reqThisHour, setReqThisHour] = useState(0);
  const [livePollPaused, setLivePollPaused] = useState(false);

  const lastFetchRef = useRef(0);
  const backoffUntilRef = useRef(0);
  const backoffStepRef = useRef(0);
  // Latest settings, for async sync callbacks (pull/conflict resolution).
  const settingsRef = useRef<StoredSettings>(DEFAULTS);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const lastPullRef = useRef(0);

  // Hydrate after mount (avoids SSR mismatch) and fetch the server config.
  useEffect(() => {
    setSettings(loadSettings());
    setNowMs(Date.now());
    setReqThisHour(pruneLoad().length);
    setAuthed(hasValidAuth());
    setHydrated(true);
    getConfig()
      .then((c) => {
        setServerManaged(!!c.serverToken);
        setPasswordRequired(!!c.passwordRequired);
        setMisconfigured(c.misconfigured ?? null);
        setServerCache(c.cache ?? { enabled: false, intervalSec: null });
        setSyncEnabled(c.sync?.enabled ?? false);
        setSyncMisconfig(c.sync?.misconfigured ?? null);
      })
      .catch(() => {
        setServerManaged(false);
      });
  }, []);

  // With the server cache on, its interval sets the poll rate and the
  // per-device picker is hidden.
  const cacheEnabled = serverCache.enabled && !!serverCache.intervalSec;
  const effectiveRefreshSec = cacheEnabled ? serverCache.intervalSec! : settings.refreshSec;
  // Poll 1s slower than the cache TTL so each poll lands after expiry and
  // gets fresh data.
  const pollIntervalSec = cacheEnabled ? serverCache.intervalSec! + 1 : settings.refreshSec;

  // 1s tick for the live clock and the request meter.
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

  // Exchange the password for a session token. Only the token is stored.
  const submitPassword = useCallback(async (password: string) => {
    setPwBusy(true);
    setPwError(null);
    try {
      await login(password);
      setAuthed(true);
    } catch (e) {
      setPwError(
        isRateLimit(e) ? 'Too many attempts. Wait a moment and try again.' : 'Incorrect password.'
      );
    } finally {
      setPwBusy(false);
    }
  }, []);

  // Verify credentials and load the workspace/project list, from the 24h
  // cache unless forced (Connect/Reconnect).
  const connect = useCallback(
    async (token: string, force = false) => {
      setConnecting(true);
      setAuthError(null);
      try {
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
        // Session missing/expired (or password rotated): back to the gate.
        if (isAuthRequired(e)) {
          setAuthed(false);
          return;
        }
        setAuthError(
          isRateLimit(e)
            ? 'Toggl rate limit reached. Wait a bit, then try again.'
            : serverManaged
            ? 'The server-configured Toggl token was rejected. Check TOGGL_API_TOKEN.'
            : 'Could not authenticate with Toggl. Check your API token.'
        );
        setShowSettings(true);
      } finally {
        setConnecting(false);
      }
    },
    [backend, metered, serverManaged]
  );

  // Connect once the server-token status is known.
  useEffect(() => {
    if (!hydrated || serverManaged === null || ready) return;
    // A deployment problem: show it, don't connect.
    if (misconfigured) {
      setAuthError(misconfigured);
      setShowSettings(true);
      return;
    }
    if (serverManaged) {
      // Behind a password gate, wait for a session; the proxy would reject us.
      if (passwordRequired && !authed) return;
      connect(''); // server holds the credential; ignore any stored browser token
    } else if (settings.token) {
      connect(settings.token);
    } else {
      setShowSettings(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, serverManaged, passwordRequired, authed, misconfigured]);

  // Poll time entries: one request, which includes the running timer.
  // Self-scheduling so it can pause while the tab is hidden and back off on
  // rate limits.
  useEffect(() => {
    if (!ready || livePollPaused) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const intervalMs = Math.max(30, pollIntervalSec) * 1000;

    const fetchNow = async () => {
      lastFetchRef.current = Date.now();
      // In cache mode most polls are server cache hits; don't count them.
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
          // Session expired: back to the password gate.
          setReady(false);
          setAuthed(false);
          return;
        }
        if (isRateLimit(e)) {
          backoffStepRef.current = Math.min(backoffStepRef.current + 1, 5);
          const wait = Math.min(intervalMs * 2 ** backoffStepRef.current, 15 * 60_000);
          backoffUntilRef.current = Date.now() + wait;
          setFetchError('Rate limited by Toggl. Slowing down automatically.');
        } else {
          setFetchError('Failed to refresh data.');
        }
      }
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
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ready, livePollPaused, settings.token, pollIntervalSec, cacheEnabled, backend, metered]);

  // In cache mode an unforced fetch is usually a cache hit and is not counted;
  // a forced one always reaches Toggl and is. Errors (including AuthRequired)
  // are thrown to the caller.
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

  // ---- Cross-device settings sync ----
  // Pull on load and on focus; push (debounced) when the syncable content
  // differs from the last-synced hash in the sync bookmark (tqv.sync.v1). The
  // hash keeps identical content from generating traffic and stops a pulled
  // document echoing back as a push. Conflicts (both sides changed since the
  // last common revision) are never auto-resolved: the server document waits
  // in `syncConflict` for the user to pick in Settings.
  const syncActive = syncEnabled && hydrated && (!passwordRequired || authed);

  const applyRemoteDoc = useCallback(
    (doc: SyncDoc) => {
      saveSyncMeta({ rev: doc.rev, hash: payloadHash(doc.payload) });
      persist(applySyncPayload(settingsRef.current, doc.payload));
      setSyncConflict(null);
      setLastSyncedAt(Date.now());
      // Forms holding mount-time snapshots must re-seed. Otherwise their next
      // save writes stale values back at the new revision, which no conflict
      // check would catch.
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
        // The server is ahead. Adopt it unless this device has unsynced
        // changes; then the user picks.
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
      // Re-run the push effect so local drift is uploaded.
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

  // Pull on activation and on focus, throttled to once per 30s.
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
    // A pristine, never-synced device must not create the server document,
    // or the user's real device would hit a conflict over defaults.
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
      // Keep this device: overwrite the server's revision.
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
          // Another device pushed meanwhile; re-offer with the newest copy.
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

  // The sync payload as a file, for deployments without a sync store.
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

  // ---- Stored workspaces (the presets in the settings) ----
  const storedWorkspaces = useMemo(
    () => settings.presets.map((p) => ({ id: p.id, name: p.name, value: p.value })),
    [settings.presets]
  );

  // Content decides whether any workspace is active; the recalled id picks
  // which, since presetMatches ignores export details and two workspaces can
  // differ only in those.
  const activeWorkspace = useMemo(() => {
    const matching = storedWorkspaces.filter((w) => presetMatches(w.value, settings));
    return matching.find((w) => w.id === settings.activePresetId) ?? matching[0] ?? null;
  }, [storedWorkspaces, settings]);

  const activeWorkspaceRef = useRef<string | null>(null);
  useEffect(() => {
    activeWorkspaceRef.current = activeWorkspace?.id ?? null;
  }, [activeWorkspace]);

  // Same as clicking a workspace in Settings → Workspaces.
  const switchWorkspace = useCallback(
    (id: string) => {
      const ws = storedWorkspaces.find((w) => w.id === id);
      if (!ws) return;
      persist(applyPreset(settingsRef.current, ws, projects));
    },
    [storedWorkspaces, persist, projects]
  );

  const setExportFields = useCallback<UseTrackSource['setExportFields']>(
    (fields) => {
      const value = normalizeExportFields(fields);
      const prev = settingsRef.current;
      if (exportFieldsEqual(prev.exportFields, value)) return;
      const activeId = activeWorkspaceRef.current;
      // Presets live in the settings, so update the active one (only that
      // one) in the same write. Each workspace keeps its own details.
      const presets = prev.presets.map((p) =>
        p.id === activeId ? { ...p, value: { ...p.value, exportFields: value } } : p
      );
      persist({ ...prev, exportFields: value, presets });
    },
    [persist]
  );

  return {
    hydrated,
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
    workspaceList: storedWorkspaces,
    switchWorkspace,
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
  };
}
