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

import { useCallback, useEffect, useRef, useState } from 'react';
import { getConfig } from '@/lib/source/config';
import { hasValidAuth, login } from '@/lib/source/auth';
import { ApiError, isRateLimit, isAuthRequired } from '@/lib/source/errors';
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
import type { SourceMode, TrackProject } from '@/lib/source/types';
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
} from '@/lib/calc';

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
  // recall from the dashboard to quick-switch between setups (see SettingsPreset).
  // Toggl mode only — in standalone mode workspaces live in the store instead.
  presets: SettingsPreset[];
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
  roundingHours: DEFAULT_ROUNDING_HOURS,
  noOvertime: false,
  codeMappings: [],
  refreshSec: DEFAULT_REFRESH_SEC,
  timesheetMode: 'summary',
  exportName: '',
  presets: [],
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
  };
}

function loadSettings(): StoredSettings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Migrate the v1 single-project shape ({ projectId, projectName }) to the
    // selectedProjects array — in place, so every other stored setting survives.
    if (!parsed.selectedProjects && parsed.projectId != null) {
      parsed.selectedProjects = [
        { id: parsed.projectId, name: (parsed.projectName as string) ?? '' },
      ];
    }
    delete parsed.projectId;
    delete parsed.projectName;
    return { ...DEFAULTS, ...parsed };
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
  // way the live poll is (skipped when a plain cache hit is expected).
  loadRange: (startISO: string, endISO: string, opts?: { force?: boolean }) => Promise<TimeEntry[]>;

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
  // Workspace CRUD (Settings). Each refreshes the workspace/project lists.
  createWorkspace: (name: string, settings?: PresetValue) => Promise<StoreWorkspace | null>;
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

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [reqThisHour, setReqThisHour] = useState(0);
  const [livePollPaused, setLivePollPaused] = useState(false);

  const lastFetchRef = useRef(0);
  const backoffUntilRef = useRef(0);
  const backoffStepRef = useRef(0);
  const refetchRef = useRef<(() => void) | null>(null);
  const entriesRef = useRef<TimeEntry[]>([]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

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
            ? 'Could not reach the store. Check MONGODB_URI on the server.'
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
        const ent = await backend.fetchEntries(
          settings.token,
          new Date(win.startMs).toISOString(),
          new Date(win.endMs).toISOString()
        );
        if (cancelled) return;
        setEntries(ent ?? []);
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
    async (startISO: string, endISO: string, opts?: { force?: boolean }): Promise<TimeEntry[]> => {
      const force = opts?.force === true;
      if (metered && (!cacheEnabled || force)) setReqThisHour(recordReqs(1));
      const ent = await backend.fetchEntries(settings.token, startISO, endISO, { force });
      return ent ?? [];
    },
    [backend, metered, cacheEnabled, settings.token]
  );

  const refetchEntries = useCallback(() => {
    refetchRef.current?.();
  }, []);
  const clearMutationError = useCallback(() => setMutationError(null), []);

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
        return result;
      } catch (e) {
        setEntries(snapshot);
        if (isAuthRequired(e)) {
          setReady(false);
          setAuthed(false);
        } else {
          setMutationError(failMessage);
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

  const workspaceOp = useCallback(
    async <R,>(run: () => Promise<R>, failMessage: string): Promise<R | null> => {
      try {
        const result = await run();
        await refreshWorkspaces();
        return result;
      } catch (e) {
        if (isAuthRequired(e)) {
          setReady(false);
          setAuthed(false);
        } else {
          setMutationError(failMessage);
        }
        return null;
      }
    },
    [refreshWorkspaces]
  );

  const createWorkspace = useCallback<UseTrackSource['createWorkspace']>(
    (name, settingsSnapshot) =>
      workspaceOp(
        () => createWorkspaceApi(name, settingsSnapshot),
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
        await refreshWorkspaces();
        return 'ok';
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) return 'has-entries';
        if (isAuthRequired(e)) {
          setReady(false);
          setAuthed(false);
        } else {
          setMutationError('Could not delete the workspace.');
        }
        return null;
      }
    },
    [refreshWorkspaces]
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
    nowMs,
    reqThisHour,
    cacheEnabled,
    effectiveRefreshSec,
    showSettings,
    setShowSettings,
    livePollPaused,
    setLivePollPaused,
    loadRange,
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
