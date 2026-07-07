'use client';

// The tracker — standalone mode's replacement for the Toggl Track timer view.
//
// Add bar on top (timer or manual entry, billing-tag autocomplete), below it
// the entry list newest-first, grouped by day inside Saturday-start weeks with
// day/week totals. The current week comes live from the shared poll
// (useTrackSource); older history is fetched on demand: the last ~14 days
// (capped at 100 entries) load on open, scrolling extends the list in 14-day
// chunks down to a 2-month horizon, and a "Load older" button moves the
// horizon another 2 months at a time.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import AppSettings from '@/components/AppSettings';
import MutationToast from '@/components/MutationToast';
import PasswordGate from '@/components/PasswordGate';
import AddBar from '@/components/tracker/AddBar';
import EntryRow from '@/components/tracker/EntryRow';
import { durationSec, isRunning, prefixFor } from '@/components/tracker/util';
import { useTrackSource, pollWindow } from '@/lib/useTrackSource';
import { fetchStoreEntries } from '@/lib/source/standalone';
import { startOfDay, startOfWeek, fmtHM, type TimeEntry } from '@/lib/calc';

const DAY_MS = 24 * 3600 * 1000;
const CHUNK_MS = 14 * DAY_MS; // how much further back each scroll-load reaches
const HORIZON_MS = 61 * DAY_MS; // ~2 months of auto-loading per "Load older"
const INITIAL_LIMIT = 100;
const CHUNK_LIMIT = 500;

interface DayGroup {
  dayStart: number;
  label: string;
  totalSec: number;
  entries: TimeEntry[];
}
interface WeekGroup {
  weekStart: number;
  label: string;
  totalSec: number;
  days: DayGroup[];
}

export default function TrackerPage() {
  const t = useTrackSource();
  const {
    hydrated,
    mode,
    settings,
    workspaces,
    serverManaged,
    passwordRequired,
    authed,
    pwError,
    pwBusy,
    submitPassword,
    ready,
    entries,
    nowMs,
    fetchError,
    showSettings,
    setShowSettings,
  } = t;

  const standalone = mode === 'standalone';
  const needsPassword = serverManaged === true && passwordRequired && !authed;

  // ---- Older history (before the shared poll's window) ----
  const [older, setOlder] = useState<TimeEntry[]>([]);
  // Everything down to this ms is loaded; the next chunk continues from here.
  const [oldestLoaded, setOldestLoaded] = useState<number | null>(null);
  // Auto-loading (scroll) stops at this horizon; the button pushes it back.
  const [autoLimit, setAutoLimit] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const initializedRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ready || !standalone || initializedRef.current) return;
    initializedRef.current = true;
    const now = Date.now();
    setAutoLimit(now - HORIZON_MS);
    const end = pollWindow(new Date(now)).startMs; // the live poll covers from here on
    const from = Math.min(now - CHUNK_MS, end);
    setLoadingOlder(true);
    fetchStoreEntries(new Date(from).toISOString(), new Date(end).toISOString(), INITIAL_LIMIT)
      .then((res) => {
        setOlder(res);
        // A full page means there may be more inside the window — continue from
        // the oldest entry we actually got instead of skipping past it.
        setOldestLoaded(
          res.length === INITIAL_LIMIT
            ? Math.min(...res.map((e) => Date.parse(e.start)))
            : from
        );
      })
      .catch(() => setOlderError('Could not load recent history.'))
      .finally(() => setLoadingOlder(false));
  }, [ready, standalone]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || oldestLoaded === null) return;
    const to = oldestLoaded;
    const from = to - CHUNK_MS;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const res = await fetchStoreEntries(
        new Date(from).toISOString(),
        new Date(to).toISOString(),
        CHUNK_LIMIT
      );
      setOlder((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        for (const e of res) if (!byId.has(e.id)) byId.set(e.id, e);
        return [...byId.values()];
      });
      setOldestLoaded(
        res.length === CHUNK_LIMIT ? Math.min(...res.map((e) => Date.parse(e.start))) : from
      );
    } catch {
      setOlderError('Could not load older entries.');
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, oldestLoaded]);

  // Auto-load older chunks while the bottom sentinel is visible, until the
  // horizon; the "Load older" button then extends the horizon.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || oldestLoaded === null || oldestLoaded <= autoLimit) return;
    const obs = new IntersectionObserver((ents) => {
      if (ents[0]?.isIntersecting) loadOlder();
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [oldestLoaded, autoLimit, loadOlder]);

  // ---- Merged list & grouping ----
  const merged = useMemo(() => {
    const byId = new Map<number, TimeEntry>();
    for (const e of older) byId.set(e.id, e);
    for (const e of entries) byId.set(e.id, e); // the live poll wins on overlap
    return [...byId.values()];
  }, [older, entries]);

  const weeks = useMemo((): WeekGroup[] => {
    if (!nowMs) return [];
    const todayStart = startOfDay(new Date(nowMs)).getTime();
    const thisWeek = startOfWeek(new Date(nowMs)).getTime();

    const dayLabel = (dayStart: number) =>
      dayStart === todayStart
        ? 'Today'
        : dayStart === todayStart - DAY_MS
        ? 'Yesterday'
        : new Date(dayStart).toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          });
    const fmtDay = (ms: number) =>
      new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const weekLabel = (ws: number) =>
      ws === thisWeek
        ? 'This week'
        : ws === thisWeek - 7 * DAY_MS
        ? 'Last week'
        : `${fmtDay(ws)} – ${fmtDay(ws + 6 * DAY_MS)}`;

    // Newest first; the running entry pins to the top of its (today's) group.
    const sorted = [...merged].sort((a, b) => {
      const ra = isRunning(a) ? 1 : 0;
      const rb = isRunning(b) ? 1 : 0;
      if (ra !== rb) return rb - ra;
      return Date.parse(b.start) - Date.parse(a.start);
    });

    const out: WeekGroup[] = [];
    for (const e of sorted) {
      const startMs = Date.parse(e.start);
      const dayStart = startOfDay(new Date(startMs)).getTime();
      const weekStart = startOfWeek(new Date(startMs)).getTime();
      let week = out[out.length - 1];
      if (!week || week.weekStart !== weekStart) {
        week = { weekStart, label: weekLabel(weekStart), totalSec: 0, days: [] };
        out.push(week);
      }
      let day = week.days[week.days.length - 1];
      if (!day || day.dayStart !== dayStart) {
        day = { dayStart, label: dayLabel(dayStart), totalSec: 0, entries: [] };
        week.days.push(day);
      }
      const dur = durationSec(e, nowMs);
      day.entries.push(e);
      day.totalSec += dur;
      week.totalSec += dur;
    }
    return out;
  }, [merged, nowMs]);

  // ---- Mutations: keep the page-owned older list reconciled ----
  const pollStartMs = nowMs ? pollWindow(new Date(nowMs)).startMs : 0;
  const syncOlder = useCallback(
    (ce: TimeEntry | null) => {
      if (!ce) return;
      setOlder((prev) => {
        if (prev.some((e) => e.id === ce.id)) return prev.map((e) => (e.id === ce.id ? ce : e));
        // A backdated creation that the hook's poll window won't cover.
        if (Date.parse(ce.start) < pollStartMs) return [...prev, ce];
        return prev;
      });
    },
    [pollStartMs]
  );

  const workspaceIds = useMemo(() => new Set(workspaces.map((w) => w.id)), [workspaces]);
  const defaultWorkspaceId =
    settings.selectedProjects.find((p) => workspaceIds.has(p.id))?.id ?? workspaces[0]?.id ?? 0;

  const running = merged.find(isRunning) ?? null;

  const handleContinue = (e: TimeEntry) =>
    t.startTimer({
      description: e.description ?? '',
      tags: e.tags ?? [],
      workspaceId: e.project_id ?? defaultWorkspaceId,
    });

  // First run: nothing to track against yet — open settings, where the
  // Workspaces section creates the first workspace (same as the dashboard's
  // pick-a-project prompt).
  useEffect(() => {
    if (ready && standalone && workspaces.length === 0) setShowSettings(true);
  }, [ready, standalone, workspaces.length, setShowSettings]);

  // ---- Render ----
  if (!hydrated || mode === null) {
    return <div className="center-msg">Loading…</div>;
  }

  if (!standalone) {
    return (
      <div className="center-msg" style={{ flexDirection: 'column', gap: 12 }}>
        <span>
          The tracker is part of standalone mode — this deployment reads from Toggl Track, so
          tracking happens in Toggl itself.
        </span>
        <Link className="navbtn" href="/">
          <span className="navbtn-icon">⌂</span>
          <span className="navbtn-text">Back to the dashboard</span>
        </Link>
      </div>
    );
  }

  const hasWorkspace = workspaces.length > 0;

  return (
    <>
      <div className="tracker-page">
        <header className="topbar">
          <div className="brand">
            <h1>Tracker</h1>
            <p>
              {hasWorkspace
                ? `${workspaces.length} workspace${workspaces.length > 1 ? 's' : ''} · entries sync every 30s`
                : 'No workspaces yet'}
            </p>
          </div>
          <div className="topbar-actions">
            <Link className="navbtn" href="/" aria-label="Dashboard">
              <span className="navbtn-icon">⌂</span>
              <span className="navbtn-text">Dashboard</span>
            </Link>
            <Link className="navbtn" href="/timesheet" aria-label="Timesheet">
              <span className="navbtn-icon">🧾</span>
              <span className="navbtn-text">Timesheet</span>
            </Link>
            <button className="iconbtn" aria-label="Settings" onClick={() => setShowSettings(true)}>
              ⚙
            </button>
          </div>
        </header>

        {!hasWorkspace ? (
          <div className="center-msg" style={{ height: 'auto' }}>
            Create a workspace in settings to start tracking.
          </div>
        ) : (
          <>
            <AddBar
              workspaces={workspaces}
              defaultWorkspaceId={defaultWorkspaceId}
              running={running}
              nowMs={nowMs}
              onStart={(input) => t.startTimer(input)}
              onStop={(id) => t.stopTimer(id)}
              onAdd={async (input) => {
                const ce = await t.addEntry(input);
                syncOlder(ce);
                return ce !== null;
              }}
              onEditRunning={(id, patch) => t.editEntry(id, patch)}
            />

            <div className="tr-list">
              {weeks.length === 0 && !loadingOlder && (
                <div className="center-msg" style={{ height: 'auto' }}>
                  No entries yet — start the timer above.
                </div>
              )}
              {weeks.map((w) => (
                <section key={w.weekStart} className="tr-week">
                  <div className="tr-week-head">
                    <span>{w.label}</span>
                    <span className="tr-week-total">{fmtHM(w.totalSec)}</span>
                  </div>
                  {w.days.map((d) => (
                    <div key={d.dayStart} className="tr-day">
                      <div className="tr-day-head">
                        <span>{d.label}</span>
                        <span className="tr-day-total">{fmtHM(d.totalSec)}</span>
                      </div>
                      {d.entries.map((e) => (
                        <EntryRow
                          key={e.id}
                          entry={e}
                          nowMs={nowMs}
                          workspaces={workspaces}
                          prefix={prefixFor(workspaces, e.project_id)}
                          showChip={workspaces.length > 1}
                          onEdit={async (id, patch) => syncOlder(await t.editEntry(id, patch))}
                          onContinue={handleContinue}
                          onDelete={async (id) => {
                            if (await t.removeEntry(id)) {
                              setOlder((prev) => prev.filter((x) => x.id !== id));
                            }
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </section>
              ))}

              <div className="tr-more">
                {loadingOlder ? (
                  <span className="tr-more-status">Loading…</span>
                ) : olderError ? (
                  <>
                    <span className="err">{olderError}</span>
                    <button className="navbtn" onClick={loadOlder}>
                      Retry
                    </button>
                  </>
                ) : oldestLoaded !== null && oldestLoaded <= autoLimit ? (
                  <button
                    className="navbtn"
                    onClick={() => setAutoLimit((l) => l - HORIZON_MS)}
                  >
                    Load older entries
                  </button>
                ) : (
                  // While above the horizon, this sentinel auto-loads on scroll.
                  <div ref={sentinelRef} className="tr-sentinel" aria-hidden="true" />
                )}
              </div>
            </div>
          </>
        )}

        <footer className="footer">
          {fetchError ? (
            <span className="err">{fetchError}</span>
          ) : (
            <span>Synced every 30s · instantly after every change</span>
          )}
        </footer>
      </div>

      <MutationToast t={t} />

      {needsPassword && <PasswordGate onSubmit={submitPassword} error={pwError} busy={pwBusy} />}

      {!needsPassword && showSettings && <AppSettings t={t} canClose={hasWorkspace} />}
    </>
  );
}
