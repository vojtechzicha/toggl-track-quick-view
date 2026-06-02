'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import ProgressRing from '@/components/ProgressRing';
import SettingsPanel, { SettingsValue } from '@/components/SettingsPanel';
import { getConfig, getMe, getProjects, getCurrent, getEntries, Project } from '@/lib/toggl';
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
const POLL_MS = 30_000;
const SNOOZE_MS = 15 * 60_000;

interface StoredSettings extends SettingsValue {
  workspaceId: number | null;
}

const DEFAULTS: StoredSettings = {
  token: '',
  workspaceId: null,
  projectId: null,
  projectName: '',
  shortFriday: false,
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
  const [current, setCurrent] = useState<TimeEntry | null>(null);
  const [nowMs, setNowMs] = useState(0);
  const [snoozeUntil, setSnoozeUntil] = useState(0);

  // Hydrate from localStorage after mount (avoids SSR/client mismatch) and
  // find out whether the server already holds a token.
  useEffect(() => {
    setSettings(loadSettings());
    setNowMs(Date.now());
    setHydrated(true);
    getConfig()
      .then((c) => setServerManaged(!!c.serverToken))
      .catch(() => setServerManaged(false));
  }, []);

  // 1s tick drives the live clock for any running entry.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
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

  // Verify token, resolve workspace, load project list.
  const connect = useCallback(
    async (token: string) => {
      setConnecting(true);
      setAuthError(null);
      try {
        const me = await getMe(token);
        const workspaceId = me.default_workspace_id;
        const projs = await getProjects(token, workspaceId);
        const sorted = (projs ?? [])
          .filter((p) => p.active !== false)
          .sort((a, b) => a.name.localeCompare(b.name));
        setProjects(sorted);
        setSettings((prev) => ({ ...prev, token, workspaceId }));
        setReady(true);
      } catch {
        setReady(false);
        setProjects([]);
        setAuthError(
          serverManaged
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

  // Once we know the server-token status, connect appropriately.
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

  // Poll time entries + the running entry while connected.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;

    const load = async () => {
      try {
        const start = startOfWeekMonday(new Date()).toISOString();
        const end = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        const [ent, cur] = await Promise.all([
          getEntries(settings.token, start, end),
          getCurrent(settings.token),
        ]);
        if (cancelled) return;
        setEntries(ent ?? []);
        setCurrent(cur ?? null);
        setFetchError(null);
      } catch {
        if (!cancelled) setFetchError('Failed to refresh data from Toggl.');
      }
    };

    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [ready, settings.token]);

  const projectNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of projects) m.set(p.id, p.name);
    return m;
  }, [projects]);

  // Merge the running entry into the week list (dedupe by id).
  const merged = useMemo(() => {
    const map = new Map<number, TimeEntry>();
    for (const e of entries) map.set(e.id, e);
    if (current) map.set(current.id, current);
    return Array.from(map.values());
  }, [entries, current]);

  const view = useMemo(() => {
    if (!settings.projectId || !nowMs) return null;
    const norm = normalize(merged, nowMs);
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
  }, [merged, nowMs, settings.projectId, settings.shortFriday, projectNameById]);

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
              {settings.token ? 'Pick a project in settings to begin.' : 'Connect Toggl to begin.'}
            </div>
          )}
        </div>

        <footer className="footer">
          {fetchError ? (
            <span className="err">{fetchError}</span>
          ) : (
            <span>Auto-refreshes every 30s · live counter updates each second</span>
          )}
        </footer>
      </div>

      {showSettings && (
        <SettingsPanel
          initial={{
            token: settings.token,
            projectId: settings.projectId,
            projectName: settings.projectName,
            shortFriday: settings.shortFriday,
          }}
          projects={projects}
          serverManaged={!!serverManaged}
          authError={authError}
          connecting={connecting}
          onConnect={connect}
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
