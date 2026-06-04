'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ProgressRing from '@/components/ProgressRing';
import SettingsPanel, { SettingsValue } from '@/components/SettingsPanel';
import PasswordGate from '@/components/PasswordGate';
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
import {
  TimeEntry,
  NormEntry,
  Gap,
  normalize,
  projectSecondsInRange,
  dailyTargetSeconds,
  plannedTargetSeconds,
  continuousWorkSeconds,
  unreportedGaps,
  startOfDay,
  startOfWeekMonday,
  fmtHM,
  fmtClock,
  fmtTimeOfDay,
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
  // Password gate (server-managed deploy with APP_PASSWORD set). `authed` tracks
  // whether we hold a valid session token; the password itself is never stored.
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  // Shared server-side cache. When enabled, the refresh cadence is driven by
  // the server (not the per-device picker), so all devices share its budget.
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
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const [reqThisHour, setReqThisHour] = useState(0);
  const [dayTab, setDayTab] = useState<'today' | 'yesterday'>('today');

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
  // Interval to display in the UI (the configured server cadence).
  const effectiveRefreshSec = cacheEnabled ? serverCache.intervalSec! : settings.refreshSec;
  // Actual poll cadence. In cache mode we poll one second SLOWER than the cache
  // TTL so a client's poll reliably arrives just after the entry has expired —
  // a guaranteed miss → freshly-refreshed data — instead of landing a hair
  // early, getting a hit, and only refreshing every other poll (which would
  // leave a lone client looking at ~2× the interval of stale data). A miss
  // resets the cache clock, so upstream usage stays ~1 fetch per interval.
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
    const intervalMs = Math.max(30, pollIntervalSec) * 1000;

    const fetchNow = async () => {
      lastFetchRef.current = Date.now();
      // In cache mode this device's poll is usually a server cache hit (no Toggl
      // call), so the per-device hourly meter would over-count — skip it.
      if (!cacheEnabled) setReqThisHour(recordReqs(1));
      try {
        // From Monday (needed for the short-Friday weekly model) but never later
        // than the start of yesterday, so unreported-time detection always has
        // both yesterday and today even on a Monday (when yesterday is Sunday,
        // i.e. last week).
        const weekStart = startOfWeekMonday(new Date()).getTime();
        const yesterdayStart = startOfDay(new Date()).getTime() - 24 * 3600 * 1000;
        const start = new Date(Math.min(weekStart, yesterdayStart)).toISOString();
        // Up to "now" only — avoids pulling any future-dated (e.g. tomorrow) entries.
        const end = new Date(Date.now() + 60 * 1000).toISOString();
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

  const view = useMemo(() => {
    if (!settings.projectId || !nowMs) return null;
    const norm = normalize(entries, nowMs);
    const now = new Date(nowMs);
    const dayStart = startOfDay(now).getTime();

    const trackedToday = projectSecondsInRange(norm, settings.projectId, dayStart, nowMs);
    const target = dailyTargetSeconds(now, norm, settings.projectId, settings.shortFriday);
    const remaining = Math.max(0, target - trackedToday);
    const fraction = target > 0 ? trackedToday / target : 1;
    // Projected wall-clock time you hit the target (if still working toward it).
    const leaveAtMs = remaining > 0 ? nowMs + remaining * 1000 : null;

    const runningEntry = norm.find((e) => e.running) ?? null;
    const trackingProject = !!runningEntry && runningEntry.projectId === settings.projectId;
    const trackingOther = !!runningEntry && runningEntry.projectId !== settings.projectId;
    // Working on a different project never surfaces that project's name. Before
    // the daily target is reached it counts as a "Break"; once it's reached,
    // any other work is just "No tracking".
    const otherLabel = trackingOther ? (remaining <= 0 ? 'No tracking' : 'Break') : '';
    const runningRaw = entries.find((e) => e.duration < 0 || !e.stop) ?? null;
    const currentDescription = runningRaw?.description?.trim() || '';
    // Live elapsed time of whatever entry is currently running (ticks each second).
    const currentSeconds = runningRaw
      ? Math.max(0, (nowMs - new Date(runningRaw.start).getTime()) / 1000)
      : 0;

    const cont = continuousWorkSeconds(norm, settings.projectId, nowMs);
    const breakDue = cont.working && cont.seconds >= BREAK_AFTER_HOURS * 3600;
    // Projected wall-clock time the next break is due (while working on project).
    const timeToBreak = cont.working ? Math.max(0, BREAK_AFTER_HOURS * 3600 - cont.seconds) : 0;
    const breakAtMs = cont.working && !breakDue ? nowMs + timeToBreak * 1000 : null;

    // A single "next thing to happen" — whichever of the next break or the
    // end-of-day target is sooner. This is the only time shown on the dashboard.
    const candidates: { kind: 'break' | 'leave'; at: number }[] = [];
    if (breakAtMs) candidates.push({ kind: 'break', at: breakAtMs });
    if (leaveAtMs) candidates.push({ kind: 'leave', at: leaveAtMs });
    candidates.sort((a, b) => a.at - b.at);
    const nextMilestone = candidates[0] ?? null;

    return {
      trackedToday,
      target,
      remaining,
      fraction,
      leaveAtMs,
      trackingProject,
      trackingOther,
      otherLabel,
      currentDescription,
      currentSeconds,
      continuous: cont.seconds,
      working: cont.working,
      breakDue,
      breakAtMs,
      nextMilestone,
    };
  }, [entries, nowMs, settings.projectId, settings.shortFriday]);

  // Day timelines for the side panel (no extra API calls — both days come from
  // the same week fetch). Only entries that *start* within the day are listed;
  // entries on any other project collapse into a single "Break" block (working
  // elsewhere counts as a break here). Genuine unreported gaps (no entry on any
  // project) are interleaved as their own markers.
  type TLItem = {
    key: string;
    kind: 'project' | 'break' | 'unreported';
    desc: string;
    startMs: number;
    stopMs: number;
    running: boolean;
    dur: number;
  };
  const timelines = useMemo(() => {
    const empty = { today: [] as TLItem[], yesterday: [] as TLItem[] };
    if (!nowMs) return empty;
    const norm = normalize(entries, nowMs);
    const dayMs = 24 * 3600 * 1000;

    const build = (dayStart: number, cap: number, isToday: boolean): TLItem[] => {
      const dayEnd = dayStart + dayMs;
      const dayEntries = entries
        .map((e) => {
          const startMs = new Date(e.start).getTime();
          const running = e.duration < 0 || !e.stop;
          const rawStop = running ? nowMs : new Date(e.stop as string).getTime();
          return {
            id: e.id,
            desc: e.description?.trim() || '(no description)',
            projectId: e.project_id,
            startMs,
            stopMs: Math.min(rawStop, cap), // clip a midnight-crossing timer to the day
            running: running && isToday,
          };
        })
        .filter((e) => e.startMs >= dayStart && e.startMs < dayEnd)
        .sort((a, b) => a.startMs - b.startMs);

      const items: TLItem[] = [];
      for (const e of dayEntries) {
        if (e.projectId === settings.projectId) {
          items.push({
            key: `e${e.id}`,
            kind: 'project',
            desc: e.desc,
            startMs: e.startMs,
            stopMs: e.stopMs,
            running: e.running,
            dur: Math.max(0, (e.stopMs - e.startMs) / 1000),
          });
        } else {
          const last = items[items.length - 1];
          if (last && last.kind === 'break') {
            last.stopMs = e.stopMs; // extend the current break across this entry
            last.running = last.running || e.running;
            last.dur = Math.max(0, (last.stopMs - last.startMs) / 1000);
          } else {
            items.push({
              key: `b${e.id}`,
              kind: 'break',
              desc: 'Break',
              startMs: e.startMs,
              stopMs: e.stopMs,
              running: e.running,
              dur: Math.max(0, (e.stopMs - e.startMs) / 1000),
            });
          }
        }
      }

      // Interleave genuine unreported gaps, computed independently of the
      // project/break grouping so a gap hidden between two other-project
      // entries still surfaces.
      for (const g of unreportedGaps(norm, dayStart, cap)) {
        items.push({
          key: `u${g.startMs}`,
          kind: 'unreported',
          desc: 'Unreported',
          startMs: g.startMs,
          stopMs: g.stopMs,
          running: false,
          dur: g.seconds,
        });
      }

      items.sort((a, b) => a.startMs - b.startMs);
      return items.reverse(); // newest first
    };

    const todayStart = startOfDay(new Date(nowMs)).getTime();
    const yesterdayStart = todayStart - dayMs;
    return {
      today: build(todayStart, nowMs, true),
      yesterday: build(yesterdayStart, todayStart, false),
    };
  }, [entries, nowMs, settings.projectId]);

  // Week summary for the side panel: logged vs target for each weekday. Mon–Fri
  // always show; Sat/Sun appear only when the selected project was tracked then.
  // Both numbers come from the same week fetch (no extra API calls). Each day's
  // target uses the daily model "as of" that day — so past days reflect what was
  // actually asked of them and today matches the main ring.
  //
  // Days still to come show the fixed weekly plan (regular 8/8/8/8/8, short
  // 9/9/9/8/5) rather than the adaptive figure, which would otherwise swing to
  // the clamp before earlier days are logged. The one exception is from Thursday
  // on: by then the adaptive numbers are meaningful, so a future Friday is shown
  // adaptively too.
  //
  // When projecting that future Friday, today (Thursday) is still in progress, so
  // its logged time is only partial. Using it raw would dump every Thursday hour
  // you haven't worked *yet* onto Friday, ballooning it. Instead we credit today
  // with at least its own committed target, so Friday only starts shrinking once
  // you work past Thursday's target.
  const weekSummary = useMemo(() => {
    if (!settings.projectId || !nowMs) return null;
    const norm = normalize(entries, nowMs);
    const dayMs = 24 * 3600 * 1000;
    const weekStart = startOfWeekMonday(new Date(nowMs)).getTime();
    const todayStart = startOfDay(new Date(nowMs)).getTime();
    const beforeThursday = new Date(nowMs).getDay() < 4; // Mon–Wed (Sun=0 counts as before)

    // Entries used only when projecting a still-future day's target: today's
    // project time is topped up to today's target (if it's short of it) so the
    // unworked remainder of today isn't charged to the future day.
    const todayTarget = dailyTargetSeconds(
      new Date(todayStart),
      norm,
      settings.projectId,
      settings.shortFriday
    );
    const todayLogged = projectSecondsInRange(norm, settings.projectId, todayStart, nowMs);
    const shortfall = Math.max(0, todayTarget - todayLogged);
    const projected: NormEntry[] =
      shortfall > 0
        ? [
            ...norm,
            {
              id: -1,
              startMs: todayStart,
              stopMs: todayStart + shortfall * 1000,
              projectId: settings.projectId,
              running: false,
            },
          ]
        : norm;

    const days: {
      key: number;
      label: string;
      logged: number;
      target: number;
      met: boolean;
    }[] = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = weekStart + i * dayMs;
      const date = new Date(dayStart);
      const isWeekend = i >= 5;
      const logged = projectSecondsInRange(
        norm,
        settings.projectId,
        dayStart,
        Math.min(dayStart + dayMs, nowMs)
      );
      if (isWeekend && logged === 0) continue; // hide untouched weekend days
      // Static plan only for genuinely-ahead days while we're still Mon–Wed;
      // today, past days, and (from Thu on) the remaining days stay adaptive.
      const isFuture = dayStart > todayStart;
      const target =
        isFuture && beforeThursday
          ? plannedTargetSeconds(date.getDay(), settings.shortFriday)
          : dailyTargetSeconds(
              date,
              isFuture ? projected : norm,
              settings.projectId,
              settings.shortFriday
            );
      days.push({
        key: dayStart,
        label: date.toLocaleDateString(undefined, { weekday: 'short' }),
        logged,
        target,
        met: logged >= target,
      });
    }
    return days;
  }, [entries, nowMs, settings.projectId, settings.shortFriday]);

  // Unreported time (no entry at all) for the side card — today and yesterday.
  const unreported = useMemo(() => {
    if (!nowMs) return null;
    const norm = normalize(entries, nowMs);
    const todayStart = startOfDay(new Date(nowMs)).getTime();
    const yesterdayStart = todayStart - 24 * 3600 * 1000;
    const today = unreportedGaps(norm, todayStart, nowMs);
    const yesterday = unreportedGaps(norm, yesterdayStart, todayStart);
    const sum = (gs: Gap[]) => gs.reduce((s, g) => s + g.seconds, 0);
    return { today, yesterday, todayTotal: sum(today), yestTotal: sum(yesterday) };
  }, [entries, nowMs]);

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

  // Block everything behind a password prompt when the deploy is gated and we
  // don't yet hold a valid session.
  const needsPassword = serverManaged === true && passwordRequired && !authed;

  const done = view ? view.remaining <= 0 : false;
  const timeline = dayTab === 'today' ? timelines.today : timelines.yesterday;
  const budgetClass =
    reqThisHour >= HOURLY_LIMIT ? 'over' : reqThisHour >= HOURLY_LIMIT - 6 ? 'warn' : '';

  return (
    <>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <h1>{settings.projectName || 'Toggl Quick View'}</h1>
            <p>
              {settings.shortFriday ? 'Short week · 40h goal' : 'Regular week · 40h goal'}
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

        <div className="main">
          <div className="stage">
            {view ? (
              <>
                <StatusBadge view={view} />

                <ProgressRing fraction={view.fraction} color={ringColor}>
                  <div className="clock">{fmtClock(view.trackedToday)}</div>
                  <div className="pct">{Math.round(view.fraction * 100)}%</div>
                  <div className="of">of {fmtHM(view.target)} target</div>
                </ProgressRing>

                {view.nextMilestone ? (
                  <div className={`next-time ${view.nextMilestone.kind}`}>
                    {view.nextMilestone.kind === 'break' ? '☕ Break at ' : '🏁 Leave at '}
                    <strong>{fmtTimeOfDay(view.nextMilestone.at)}</strong>
                  </div>
                ) : (
                  <div className="next-time done">🎉 Target reached — you can leave</div>
                )}

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

          {view && (
            <aside className="side">
              <div className="side-card">
                <div className="side-title">Currently tracking</div>
                {view.trackingProject ? (
                  <>
                    <div className="now-desc">
                      {view.currentDescription || '(no description)'}
                    </div>
                    <div className="now-meta">{settings.projectName}</div>
                    <div className="now-time">{fmtClock(view.currentSeconds)}</div>
                  </>
                ) : view.trackingOther ? (
                  <div className="now-idle">{view.otherLabel}</div>
                ) : (
                  <div className="now-idle">Nothing running</div>
                )}
              </div>

              {unreported &&
                (unreported.today.length > 0 || unreported.yesterday.length > 0) && (
                  <div className="side-card unrep-card">
                    <div className="side-title">Unreported time</div>
                    <UnreportedGroup
                      label="Today"
                      gaps={unreported.today}
                      total={unreported.todayTotal}
                    />
                    <UnreportedGroup
                      label="Yesterday"
                      gaps={unreported.yesterday}
                      total={unreported.yestTotal}
                    />
                  </div>
                )}

              {weekSummary && weekSummary.length > 0 && (
                <div className="side-card week-card">
                  <div className="side-title">This week</div>
                  <div className="week-list">
                    {weekSummary.map((d) => (
                      <div key={d.key} className="week-row">
                        <span className="week-day">{d.label}</span>
                        <span className="week-vals">
                          <span className={`week-logged ${d.met ? 'met' : ''}`}>
                            {fmtHM(d.logged)}
                          </span>
                          <span className="week-sep">/</span>
                          <span className="week-target">{fmtHM(d.target)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="side-card history-card">
                <div className="day-tabs" role="tablist">
                  <button
                    role="tab"
                    aria-selected={dayTab === 'today'}
                    className={`day-tab ${dayTab === 'today' ? 'active' : ''}`}
                    onClick={() => setDayTab('today')}
                  >
                    Today
                  </button>
                  <button
                    role="tab"
                    aria-selected={dayTab === 'yesterday'}
                    className={`day-tab ${dayTab === 'yesterday' ? 'active' : ''}`}
                    onClick={() => setDayTab('yesterday')}
                  >
                    Yesterday
                  </button>
                </div>
                <div className="history-list">
                  {timeline.length === 0 ? (
                    <div className="now-idle">
                      {dayTab === 'today' ? 'No entries yet today' : 'No entries yesterday'}
                    </div>
                  ) : (
                    timeline.map((h) =>
                      h.kind === 'unreported' ? (
                        <div key={h.key} className="gap-marker">
                          <span className="gap-text">
                            ⚠ {fmtHM(h.dur)} unreported · {fmtTimeOfDay(h.startMs)}–
                            {fmtTimeOfDay(h.stopMs)}
                          </span>
                        </div>
                      ) : (
                        <div
                          key={h.key}
                          className={`hist-item ${h.running ? 'live' : ''} ${
                            h.kind === 'break' ? 'brk' : ''
                          }`}
                        >
                          <div className="hist-top">
                            <span className="hist-desc">
                              {h.kind === 'break' ? '☕ Break' : h.desc}
                            </span>
                            <span className="hist-dur">{fmtHM(h.dur)}</span>
                          </div>
                          <div className="hist-bottom">
                            <span className="hist-time">
                              {fmtTimeOfDay(h.startMs)}–
                              {h.running ? 'now' : fmtTimeOfDay(h.stopMs)}
                            </span>
                          </div>
                        </div>
                      )
                    )
                  )}
                </div>
              </div>
            </aside>
          )}
        </div>

        <footer className="footer">
          {fetchError ? (
            <span className="err">{fetchError}</span>
          ) : cacheEnabled ? (
            <span>
              Shared server cache · refreshes every {fmtInterval(effectiveRefreshSec)} across all
              devices
            </span>
          ) : (
            <span>Refreshes every {fmtInterval(settings.refreshSec)} · live counter each second</span>
          )}
          {!cacheEnabled && (
            <span className={`budget ${budgetClass}`}>
              {' · '}≈{reqThisHour}/{HOURLY_LIMIT} API requests this hour
            </span>
          )}
        </footer>
      </div>

      {needsPassword && (
        <PasswordGate onSubmit={submitPassword} error={pwError} busy={pwBusy} />
      )}

      {!needsPassword && showSettings && (
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
          cacheInterval={cacheEnabled ? effectiveRefreshSec : null}
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

function UnreportedGroup({
  label,
  gaps,
  total,
}: {
  label: string;
  gaps: Gap[];
  total: number;
}) {
  return (
    <div className="unrep-group">
      <div className="unrep-head">
        <span>{label}</span>
        <span className={total > 0 ? 'amber' : 'ok'}>
          {total > 0 ? fmtHM(total) : '✓ all reported'}
        </span>
      </div>
      {gaps.map((g) => (
        <div key={g.startMs} className="unrep-row">
          <span className="unrep-time">
            {fmtTimeOfDay(g.startMs)}–{fmtTimeOfDay(g.stopMs)}
          </span>
          <span className="unrep-dur">{fmtHM(g.seconds)}</span>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({
  view,
}: {
  view: { trackingProject: boolean; trackingOther: boolean; otherLabel: string };
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
        <span className="dot" /> {view.otherLabel}
      </span>
    );
  }
  return (
    <span className="badge">
      <span className="dot" /> Not tracking
    </span>
  );
}
