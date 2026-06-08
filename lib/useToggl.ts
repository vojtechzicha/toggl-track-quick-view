'use client';

// Shared Toggl connection + polling for the dashboard and the timesheet page.
//
// This hook owns everything that talks to Toggl: loading settings, resolving the
// server-managed / password-gate status, connecting (cache-first), and the
// self-scheduling poll that fetches the week's entries. Both pages consume the
// SAME hook so they share one fetch cadence and never double-spend Toggl's
// hourly request budget. Page-specific derivations (the ring, timelines, the
// timesheet grid) live in the pages; this hook just hands back the raw
// ingredients (entries, nowMs, settings, gate state, errors).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getConfig,
  getMe,
  getProjects,
  getEntries,
  isRateLimit,
  isAuthRequired,
  hasValidAuth,
  login,
  Project,
} from '@/lib/toggl';
import type { SettingsValue } from '@/components/SettingsPanel';
import {
  TimeEntry,
  startOfDay,
  startOfWeekMonday,
  DEFAULT_WEEKLY_HOURS,
  DEFAULT_BILLING_TAG_PREFIX,
} from '@/lib/calc';

const LS_KEY = 'tqv.settings.v1';
const CACHE_KEY = 'tqv.cache.v1';
const REQLOG_KEY = 'tqv.reqlog.v1';
const CACHE_TTL = 24 * 3600 * 1000; // me/projects cache lifetime
const HOUR_MS = 3600 * 1000;
export const HOURLY_LIMIT = 30; // Toggl Free: 30 requests/hour
const DEFAULT_REFRESH_SEC = 180; // ~20 requests/hour, well under the limit

export interface StoredSettings extends SettingsValue {
  workspaceId: number | null;
}

export const DEFAULTS: StoredSettings = {
  token: '',
  workspaceId: null,
  projectId: null,
  projectName: '',
  shortFriday: false,
  weeklyHours: DEFAULT_WEEKLY_HOURS,
  maxBillableHours: null,
  minWorkingDayHours: null,
  billingTagPrefix: DEFAULT_BILLING_TAG_PREFIX,
  refreshSec: DEFAULT_REFRESH_SEC,
  timesheetMode: 'summary',
};

function loadSettings(): StoredSettings {
  if (typeof window === 'undefined') return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

// ---- me/projects cache (avoids spending the request budget on every reload) ----
interface Cache {
  workspaceId: number;
  projects: Project[];
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

export interface UseToggl {
  hydrated: boolean;
  settings: StoredSettings;
  setSettings: React.Dispatch<React.SetStateAction<StoredSettings>>;
  persist: (s: StoredSettings) => void;
  projects: Project[];
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
}

export function useToggl(): UseToggl {
  const [settings, setSettings] = useState<StoredSettings>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [serverManaged, setServerManaged] = useState<boolean | null>(null); // null = unknown
  const [passwordRequired, setPasswordRequired] = useState(false);
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

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [reqThisHour, setReqThisHour] = useState(0);

  const lastFetchRef = useRef(0);
  const backoffUntilRef = useRef(0);
  const backoffStepRef = useRef(0);

  // Hydrate from localStorage after mount (avoids SSR/client mismatch) and
  // find out whether the server already holds a token.
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
        setServerCache(c.cache ?? { enabled: false, intervalSec: null });
      })
      .catch(() => setServerManaged(false));
  }, []);

  // When the shared server cache is on, its interval governs polling and the
  // per-device refresh picker is hidden (the server owns the budget).
  const cacheEnabled = serverCache.enabled && !!serverCache.intervalSec;
  const effectiveRefreshSec = cacheEnabled ? serverCache.intervalSec! : settings.refreshSec;
  // Poll one second SLOWER than the cache TTL so a client's poll reliably lands
  // just after the entry has expired (a guaranteed miss → fresh data).
  const pollIntervalSec = cacheEnabled ? serverCache.intervalSec! + 1 : settings.refreshSec;

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

  // Verify token, resolve workspace, load project list. Uses the cache unless
  // forced (e.g. the user clicks Connect/Reconnect), to conserve requests.
  const connect = useCallback(
    async (token: string, force = false) => {
      setConnecting(true);
      setAuthError(null);
      try {
        if (!force) {
          const c = loadCache();
          if (c && c.projects?.length && Date.now() - c.at < CACHE_TTL) {
            setProjects(c.projects);
            setSettings((prev) => ({ ...prev, token, workspaceId: c.workspaceId }));
            setReady(true);
            return;
          }
        }
        setReqThisHour(recordReqs(2)); // me + projects
        const me = await getMe(token);
        const workspaceId = me.default_workspace_id;
        const projs = await getProjects(token, workspaceId);
        const sorted = (projs ?? [])
          .filter((p) => p.active !== false)
          .sort((a, b) => a.name.localeCompare(b.name));
        setProjects(sorted);
        setSettings((prev) => ({ ...prev, token, workspaceId }));
        saveCache({ workspaceId, projects: sorted, at: Date.now() });
        setReady(true);
      } catch (e) {
        setReady(false);
        setProjects([]);
        // Session missing/expired (or password rotated): drop back to the gate
        // instead of showing a Toggl auth error.
        if (isAuthRequired(e)) {
          setAuthed(false);
          return;
        }
        setAuthError(
          isRateLimit(e)
            ? 'Toggl rate limit reached — wait a bit, then try again.'
            : serverManaged
            ? 'The server-configured Toggl token was rejected. Check TOGGL_API_TOKEN.'
            : 'Could not authenticate with Toggl. Check your API token.'
        );
        setShowSettings(true);
      } finally {
        setConnecting(false);
      }
    },
    [serverManaged]
  );

  // Once we know the server-token status, connect appropriately (cache-first).
  useEffect(() => {
    if (!hydrated || serverManaged === null || ready) return;
    if (serverManaged) {
      // When a password gate is active, wait until we hold a session before
      // connecting — the proxy would reject the fetch anyway.
      if (passwordRequired && !authed) return;
      connect(''); // server holds the token; ignore any stored browser token
    } else if (settings.token) {
      connect(settings.token);
    } else {
      setShowSettings(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, serverManaged, passwordRequired, authed]);

  // Poll time entries. A single request (the entries list already includes the
  // running timer). Self-scheduling so we can pause while the tab is hidden and
  // back off on rate limits; the live counter ticks locally in between.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const intervalMs = Math.max(30, pollIntervalSec) * 1000;

    const fetchNow = async () => {
      lastFetchRef.current = Date.now();
      // In cache mode this device's poll is usually a server cache hit (no Toggl
      // call), so the per-device hourly meter would over-count — skip it.
      if (!cacheEnabled) setReqThisHour(recordReqs(1));
      try {
        // From Monday (needed for the short-Friday weekly model) but never later
        // than the start of yesterday, so unreported-time detection always has
        // both yesterday and today even on a Monday.
        const weekStart = startOfWeekMonday(new Date()).getTime();
        const yesterdayStart = startOfDay(new Date()).getTime() - 24 * 3600 * 1000;
        const start = new Date(Math.min(weekStart, yesterdayStart)).toISOString();
        // Through the end of this week so pre-entered ("scheduled") future entries
        // are included.
        const end = new Date(weekStart + 7 * 24 * 3600 * 1000).toISOString();
        const ent = await getEntries(settings.token, start, end);
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
          setFetchError('Failed to refresh data from Toggl.');
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
  }, [ready, settings.token, pollIntervalSec, cacheEnabled]);

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
    nowMs,
    reqThisHour,
    cacheEnabled,
    effectiveRefreshSec,
    showSettings,
    setShowSettings,
  };
}
