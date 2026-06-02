'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProgressRing from '@/components/ProgressRing';
import SettingsPanel, { SettingsValue } from '@/components/SettingsPanel';
import { getConfig, getMe, getProjects, getEntries, isRateLimit, Project } from '@/lib/toggl';
import {
  TimeEntry,
  normalize,
  projectSecondsInRange,
  dailyTargetSeconds,
  continuousWorkSeconds,
  startOfDay,
  startOfWeekMonday,
  fmtHM,
  fmtClock,
  BREAK_AFTER_HOURS,
} from '@/lib/calc';

const LS_KEY = 'tqv.settings.v1';
const CACHE_KEY = 'tqv.cache.v1';
const REQLOG_KEY = 'tqv.reqlog.v1';
const CACHE_TTL = 24 * 3600 * 1000; // me/projects cache lifetime
const HOUR_MS = 3600 * 1000;
const HOURLY_LIMIT = 30; // Toggl Free: 30 requests/hour
const SNOOZE_MS = 15 * 60_000;
const DEFAULT_REFRESH_SEC = 180; // ~20 requests/hour, well under the limit

interface StoredSettings extends SettingsValue {
  workspaceId: number | null;
}

const DEFAULTS: StoredSettings = {
  token: '',
  workspaceId: null,
  projectId: null,
  projectName: '',
  shortFriday: false,
  refreshSec: DEFAULT_REFRESH_SEC,
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

function fmtInterval(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} min` : `${sec}s`;
}

export default function Page() {
  const [settings, setSettings] = useState<StoredSettings>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);

  const [projects, setProjects] = useState<Project[]>([]);
  const [serverManaged, setServerManaged] = useState<boolean | null>(null); // null = unknown
  const [ready, setReady] = useState(false); // token verified + workspace known
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [nowMs, setNowMs] = useState(0);
  const [snoozeUntil, setSnoozeUntil] = useState(0);
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
    setHydrated(true);
    getConfig()
      .then((c) => setServerManaged(!!c.serverToken))
      .catch(() => setServerManaged(false));
  }, []);

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
      connect(''); // server holds the token; ignore any stored browser token
    } else if (settings.token) {
      connect(settings.token);
    } else {
      setShowSettings(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, serverManaged]);

  // After a successful connection, prompt for a project if none is chosen yet.
  useEffect(() => {
    if (ready && !settings.projectId) setShowSettings(true);
  }, [ready, settings.projectId]);

  // Poll time entries. A single request (the entries list already includes the
  // running timer). Self-scheduling so we can pause while the tab is hidden and
  // back off on rate limits; the live counter ticks locally in between.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const intervalMs = Math.max(30, settings.refreshSec) * 1000;

    const fetchNow = async () => {
      lastFetchRef.current = Date.now();
      setReqThisHour(recordReqs(1));
      try {
        const start = startOfWeekMonday(new Date()).toISOString();
        const end = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        const ent = await getEntries(settings.token, start, end);
        if (cancelled) return;
        setEntries(ent ?? []);
        setFetchError(null);
        backoffStepRef.current = 0;
        backoffUntilRef.current = 0;
      } catch (e) {
        if (cancelled) return;
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
  }, [ready, settings.token, settings.refreshSec]);

  const projectNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  const view = useMemo(() => {
    if (!settings.projectId || !nowMs) return null;
    const norm = normalize(entries, nowMs);
    const now = new Date(nowMs);
    const dayStart = startOfDay(now).getTime();

    const trackedToday = projectSecondsInRange(norm, settings.projectId, dayStart, nowMs);
    const target = dailyTargetSeconds(now, norm, settings.projectId, settings.shortFriday);
    const remaining = Math.max(0, target - trackedToday);
    const fraction = target > 0 ? trackedToday / target : 1;

    const runningEntry = norm.find((e) => e.running) ?? null;
    const trackingProject = !!runningEntry && runningEntry.projectId === settings.projectId;
    const trackingOther = !!runningEntry && runningEntry.projectId !== settings.projectId;
    const otherName =
      trackingOther && runningEntry?.projectId != null
        ? projectNameById.get(runningEntry.projectId) ?? 'another project'
        : '';

    const cont = continuousWorkSeconds(norm, settings.projectId, nowMs);
    const breakDue = cont.working && cont.seconds >= BREAK_AFTER_HOURS * 3600;

    return {
      trackedToday,
      target,
      remaining,
      fraction,
      trackingProject,
      trackingOther,
      otherName,
      continuous: cont.seconds,
      working: cont.working,
      breakDue,
    };
  }, [entries, nowMs, settings.projectId, settings.shortFriday, projectNameById]);

  const showBreakAlert = !!view?.breakDue && nowMs > snoozeUntil;

  const ringColor = !view
    ? 'var(--accent)'
    : showBreakAlert
    ? 'var(--amber)'
    : view.remaining <= 0
    ? 'var(--green)'
    : view.trackingProject
    ? 'var(--accent)'
    : 'var(--accent-soft)';

  // ---- Render ----
  if (!hydrated) {
    return <div className="center-msg">Loading…</div>;
  }

  const done = view ? view.remaining <= 0 : false;
  const budgetClass =
    reqThisHour >= HOURLY_LIMIT ? 'over' : reqThisHour >= HOURLY_LIMIT - 6 ? 'warn' : '';

  return (
    <>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <h1>{settings.projectName || 'Toggl Quick View'}</h1>
            <p>
              {settings.shortFriday ? 'Short-Friday week · 40h goal' : '8h work day'}
              {' · '}
              {new Date(nowMs || Date.now()).toLocaleDateString(undefined, {
                weekday: 'long',
              })}
            </p>
          </div>
          <button
            className="iconbtn"
            aria-label="Settings"
            onClick={() => setShowSettings(true)}
          >
            ⚙
          </button>
        </header>

        {showBreakAlert && (
          <div className="breakbar" role="alert">
            <span>☕</span>
            <span className="grow">
              You&apos;ve worked {fmtHM(view!.continuous)} straight — time for a break.
            </span>
            <button onClick={() => setSnoozeUntil(Date.now() + SNOOZE_MS)}>Snooze 15m</button>
          </div>
        )}

        <div className="stage">
          {view ? (
            <>
              <StatusBadge view={view} />

              <ProgressRing fraction={view.fraction} color={ringColor}>
                <div className="clock">{fmtClock(view.trackedToday)}</div>
                <div className="pct">{Math.round(view.fraction * 100)}%</div>
                <div className="of">of {fmtHM(view.target)} target</div>
              </ProgressRing>

              <div className="stats">
                <div className="stat">
                  <div className="label">Tracked today</div>
                  <div className="value">{fmtHM(view.trackedToday)}</div>
                </div>
                <div className="stat">
                  <div className="label">{done ? 'Over target' : 'Remaining'}</div>
                  <div className={`value ${done ? 'green' : ''}`}>
                    {done ? `+${fmtHM(view.trackedToday - view.target)}` : fmtHM(view.remaining)}
                  </div>
                </div>
                <div className="stat">
                  <div className="label">Continuous</div>
                  <div className={`value ${showBreakAlert ? 'amber' : ''}`}>
                    {view.working ? fmtHM(view.continuous) : '—'}
                  </div>
                </div>
              </div>
            </>
          ) : (
            <div className="center-msg" style={{ height: 'auto' }}>
              {settings.token || serverManaged
                ? 'Pick a project in settings to begin.'
                : 'Connect Toggl to begin.'}
            </div>
          )}
        </div>

        <footer className="footer">
          {fetchError ? (
            <span className="err">{fetchError}</span>
          ) : (
            <span>Refreshes every {fmtInterval(settings.refreshSec)} · live counter each second</span>
          )}
          <span className={`budget ${budgetClass}`}>
            {' · '}≈{reqThisHour}/{HOURLY_LIMIT} API requests this hour
          </span>
        </footer>
      </div>

      {showSettings && (
        <SettingsPanel
          initial={{
            token: settings.token,
            projectId: settings.projectId,
            projectName: settings.projectName,
            shortFriday: settings.shortFriday,
            refreshSec: settings.refreshSec,
          }}
          projects={projects}
          serverManaged={!!serverManaged}
          authError={authError}
          connecting={connecting}
          onConnect={(token) => connect(token, true)}
          onSave={(v) => {
            persist({ ...settings, ...v });
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
          canClose={!!settings.projectId}
        />
      )}
    </>
  );
}

function StatusBadge({
  view,
}: {
  view: { trackingProject: boolean; trackingOther: boolean; otherName: string };
}) {
  if (view.trackingProject) {
    return (
      <span className="badge live">
        <span className="dot" /> Tracking now
      </span>
    );
  }
  if (view.trackingOther) {
    return (
      <span className="badge other">
        <span className="dot" /> Tracking {view.otherName}
      </span>
    );
  }
  return (
    <span className="badge">
      <span className="dot" /> Not tracking
    </span>
  );
}
