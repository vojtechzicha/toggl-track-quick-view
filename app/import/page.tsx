'use client';

// Toggl history importer (standalone mode). Copies a Toggl account's history
// into the store.
//
// Connect with a Toggl API token (via the proxy), map each Toggl project to a
// workspace (existing, new, or skip), pick a date range, run. History is read
// oldest first in 90-day windows via GET me/time_entries, metered against the
// shared 30 requests/hour budget, pausing when it runs out or Toggl rate
// limits. Each window is POSTed to /api/store/import. Entries keep their
// Toggl id, so an interrupted import can be re-run.

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import AppSettings from '@/components/AppSettings';
import MutationToast from '@/components/MutationToast';
import PasswordGate from '@/components/PasswordGate';
import {
  useTrackSource,
  recordTogglRequests,
  togglRequestsThisHour,
} from '@/lib/useTrackSource';
import { togglBackend, getEntries, HOURLY_LIMIT } from '@/lib/source/toggl';
import { importEntriesApi, type ImportResult } from '@/lib/source/standalone';
import { isAuthRequired, isRateLimit } from '@/lib/source/errors';
import type { TrackProject } from '@/lib/source/types';

const DAY_MS = 24 * 3600 * 1000;
const WINDOW_MS = 90 * DAY_MS; // page size through Toggl history
const BATCH = 1000; // entries per bulk POST (server caps at 2000)
const BUDGET_RESERVE = 1; // requests kept free in the hourly budget
const MAX_ERROR_RETRIES = 3;

/** A mapping-table row: a Toggl project, or one of the two catch-all rows. */
interface Row {
  key: string; // the mapping key: project id, '0' (no project), '*' (any other)
  name: string;
  color?: string;
  pseudo?: boolean;
}

// A row's assignment, encoded for the <select>: 'skip', 'new', or 'ws:<id>'.
type Choice = string;

const ZERO_STATS: ImportResult = {
  imported: 0,
  duplicates: 0,
  unmapped: 0,
  invalid: 0,
  stoppedRunning: 0,
};

function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a yyyy-mm-dd input value, or null when unparseable. */
function fromDateInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(`${v}T00:00`).getTime();
  return Number.isFinite(t) ? t : null;
}

const isHex = (v: string | undefined): v is string => !!v && /^#[0-9a-f]{6}$/i.test(v.trim());

export default function ImportPage() {
  const t = useTrackSource();
  const {
    hydrated,
    mode,
    serverManaged,
    passwordRequired,
    authed,
    pwError,
    pwBusy,
    submitPassword,
    nowMs,
    showSettings,
    setShowSettings,
  } = t;

  const standalone = mode === 'standalone';
  const needsPassword = serverManaged === true && passwordRequired && !authed;

  // ---- Step 1: connect to Toggl ----
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connected, setConnected] = useState<{
    accountName: string;
    projects: TrackProject[];
  } | null>(null);

  // ---- Step 2: project → workspace assignments ----
  const [choices, setChoices] = useState<Record<string, Choice>>({});

  // ---- Step 3: range & run ----
  const [sinceStr, setSinceStr] = useState(() =>
    toDateInput(new Date(new Date().getFullYear() - 4, 0, 1))
  );
  const [untilStr, setUntilStr] = useState(() => toDateInput(new Date()));
  const [phase, setPhase] = useState<'setup' | 'running' | 'done' | 'error'>('setup');
  const [runError, setRunError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [stats, setStats] = useState<ImportResult>(ZERO_STATS);
  // Current wait (budget used up, rate limited, or retrying).
  const [pause, setPause] = useState<{ until: number; reason: string } | null>(null);
  const cancelRef = useRef(false);

  const rows = useMemo((): Row[] => {
    if (!connected) return [];
    return [
      ...connected.projects.map((p) => ({ key: String(p.id), name: p.name, color: p.color })),
      { key: '0', name: 'Entries without a project', pseudo: true },
      // Archived projects: the projects API returns only active ones.
      { key: '*', name: 'Any other project (archived / not listed)', pseudo: true },
    ];
  }, [connected]);

  const doConnect = async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      recordTogglRequests(2); // me + projects
      const info = await togglBackend.connect(token);
      setConnected({ accountName: info.accountName, projects: info.projects });
      // Defaults: map to a workspace with the same name, else a new one. The
      // catch-all rows start on "skip".
      const byName = new Map(t.workspaces.map((w) => [w.name.trim().toLowerCase(), w.id]));
      const next: Record<string, Choice> = { '0': 'skip', '*': 'skip' };
      for (const p of info.projects) {
        const existing = byName.get(p.name.trim().toLowerCase());
        next[String(p.id)] = existing ? `ws:${existing}` : 'new';
      }
      setChoices(next);
    } catch (e) {
      setConnectError(
        isAuthRequired(e)
          ? 'Session expired. Enter the app password again, then reconnect.'
          : isRateLimit(e)
          ? 'Toggl rate limit reached. Wait a bit, then try again.'
          : 'Could not connect to Toggl. Check the API token.'
      );
    } finally {
      setConnecting(false);
    }
  };

  // Wait in 1s slices so Cancel stays responsive.
  const waitOut = async (ms: number, reason: string) => {
    setPause({ until: Date.now() + ms, reason });
    const end = Date.now() + ms;
    while (Date.now() < end && !cancelRef.current) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    setPause(null);
  };

  const sinceMs = fromDateInput(sinceStr);
  const untilMs = fromDateInput(untilStr);
  const windowCount =
    sinceMs !== null && untilMs !== null && untilMs >= sinceMs
      ? Math.ceil((untilMs + DAY_MS - sinceMs) / WINDOW_MS)
      : 0;

  const run = async () => {
    if (!connected || sinceMs === null || untilMs === null || untilMs < sinceMs) return;
    cancelRef.current = false;
    setPhase('running');
    setRunError(null);
    setStats(ZERO_STATS);

    const endMs = untilMs + DAY_MS; // the picked "until" day, inclusive
    const windows: [number, number][] = [];
    for (let s = sinceMs; s < endMs; s += WINDOW_MS) {
      windows.push([s, Math.min(s + WINDOW_MS, endMs)]);
    }
    setProgress({ done: 0, total: windows.length });

    try {
      // Resolve assignments to workspace ids, creating "new" ones. Reuse a
      // workspace with the same name, so a re-run does not create duplicates.
      const mapping: Record<string, number> = {};
      const createdByName = new Map<string, number>();
      for (const row of rows) {
        const choice = choices[row.key] ?? 'skip';
        if (choice === 'skip') continue;
        if (choice.startsWith('ws:')) {
          mapping[row.key] = Number(choice.slice(3));
          continue;
        }
        const nameKey = row.name.trim().toLowerCase();
        const reuse =
          t.workspaces.find((w) => w.name.trim().toLowerCase() === nameKey)?.id ??
          createdByName.get(nameKey);
        if (reuse) {
          mapping[row.key] = reuse;
          setChoices((prev) => ({ ...prev, [row.key]: `ws:${reuse}` }));
          continue;
        }
        const created = await t.createWorkspace(
          row.name,
          undefined,
          isHex(row.color) ? row.color : undefined
        );
        if (!created) throw new Error(`Could not create the workspace “${row.name}”.`);
        createdByName.set(nameKey, created.id);
        mapping[row.key] = created.id;
        setChoices((prev) => ({ ...prev, [row.key]: `ws:${created.id}` }));
      }
      if (Object.keys(mapping).length === 0) {
        throw new Error('Nothing to import: every row is set to “Skip”.');
      }

      // Per window: wait for budget, fetch, POST. On a rate limit, back off
      // exponentially and retry the same window.
      for (const [winStart, winEnd] of windows) {
        let rateStep = 0;
        let errorTries = 0;
        for (;;) {
          if (cancelRef.current) {
            setPhase('setup');
            return;
          }
          if (togglRequestsThisHour() >= HOURLY_LIMIT - BUDGET_RESERVE) {
            await waitOut(60_000, 'Hourly Toggl request budget used up. Resuming automatically');
            continue;
          }
          try {
            recordTogglRequests(1);
            const entries =
              (await getEntries(
                token,
                new Date(winStart).toISOString(),
                new Date(winEnd).toISOString()
              )) ?? [];
            for (let i = 0; i < entries.length; i += BATCH) {
              const res = await importEntriesApi(entries.slice(i, i + BATCH), mapping);
              setStats((prev) => ({
                imported: prev.imported + res.imported,
                duplicates: prev.duplicates + res.duplicates,
                unmapped: prev.unmapped + res.unmapped,
                invalid: prev.invalid + res.invalid,
                stoppedRunning: prev.stoppedRunning + res.stoppedRunning,
              }));
            }
            break;
          } catch (e) {
            if (cancelRef.current) {
              setPhase('setup');
              return;
            }
            if (isAuthRequired(e)) {
              throw new Error(
                'Session expired. Log in and start the import again; entries already imported are skipped.'
              );
            }
            if (isRateLimit(e)) {
              rateStep = Math.min(rateStep + 1, 4);
              await waitOut(
                Math.min(60_000 * 2 ** rateStep, 15 * 60_000),
                'Rate limited by Toggl. Resuming automatically'
              );
              continue;
            }
            errorTries++;
            if (errorTries >= MAX_ERROR_RETRIES) throw e;
            await waitOut(5_000 * errorTries, 'Request failed. Retrying');
          }
        }
        setProgress((prev) => ({ ...prev, done: prev.done + 1 }));
      }

      setPhase('done');
      t.refetchEntries();
    } catch (e) {
      setPause(null);
      setRunError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  // ---- Render ----
  if (!hydrated || mode === null) {
    return <div className="center-msg">Loading…</div>;
  }

  if (!standalone) {
    return (
      <div className="center-msg" style={{ flexDirection: 'column', gap: 12 }}>
        <span>This deployment reads from Toggl Track, so there is nothing to import into.</span>
        <Link className="navbtn" href="/">
          <span className="navbtn-icon">⌂</span>
          <span className="navbtn-text">Back to the dashboard</span>
        </Link>
      </div>
    );
  }

  const running = phase === 'running';
  const pauseSecs = pause ? Math.max(0, Math.ceil((pause.until - nowMs) / 1000)) : 0;
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <>
      <div className="imp-page">
        <header className="topbar">
          <div className="brand">
            <h1>Import from Toggl</h1>
            <p>Copy your Toggl Track history into this app</p>
          </div>
          <div className="topbar-actions">
            <Link className="navbtn" href="/" aria-label="Dashboard">
              <span className="navbtn-icon">⌂</span>
              <span className="navbtn-text">Dashboard</span>
            </Link>
            <Link className="navbtn" href="/tracker" aria-label="Tracker">
              <span className="navbtn-icon">⏱</span>
              <span className="navbtn-text">Tracker</span>
            </Link>
            <button className="iconbtn" aria-label="Settings" onClick={() => setShowSettings(true)}>
              ⚙
            </button>
          </div>
        </header>

        <section className="imp-card">
          <h2>1 · Connect to Toggl</h2>
          {connected ? (
            <p className="hint">
              Connected{connected.accountName ? ` as ${connected.accountName}` : ''}.{' '}
              {connected.projects.length} active project
              {connected.projects.length === 1 ? '' : 's'} found.
            </p>
          ) : (
            <>
              <p className="hint">
                Paste your Toggl Track API token (from{' '}
                <a href="https://track.toggl.com/profile" target="_blank" rel="noreferrer">
                  track.toggl.com/profile
                </a>
                , bottom of the page). It is not saved and is only used to read your history.
              </p>
              <div className="imp-connect">
                <input
                  type="password"
                  value={token}
                  placeholder="Toggl API token"
                  autoComplete="off"
                  onChange={(e) => setToken(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && token && !connecting) doConnect();
                  }}
                />
                <button className="btn btn-primary" onClick={doConnect} disabled={!token || connecting}>
                  {connecting ? 'Connecting…' : 'Connect'}
                </button>
              </div>
            </>
          )}
          {connectError && <div className="err-msg">{connectError}</div>}
        </section>

        {connected && (
          <section className="imp-card">
            <h2>2 · Map projects to workspaces</h2>
            <p className="hint">
              Pick where each project&apos;s entries go: an existing workspace, a new one with the
              project&apos;s name and color, or nowhere.
            </p>
            <div className="imp-maptable">
              {rows.map((row) => (
                <div key={row.key} className={`imp-maprow${row.pseudo ? ' pseudo' : ''}`}>
                  <span className="imp-mapname">
                    {row.color && <span className="proj-swatch" style={{ background: row.color }} />}
                    {row.name}
                  </span>
                  <span className="imp-maparrow">→</span>
                  <select
                    value={choices[row.key] ?? 'skip'}
                    disabled={running}
                    onChange={(e) =>
                      setChoices((prev) => ({ ...prev, [row.key]: e.target.value }))
                    }
                  >
                    <option value="skip">Skip</option>
                    <option value="new">➕ New workspace “{row.name}”</option>
                    {t.workspaces.map((w) => (
                      <option key={w.id} value={`ws:${w.id}`}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </section>
        )}

        {connected && (
          <section className="imp-card">
            <h2>3 · Date range & run</h2>
            <div className="imp-range">
              <label>
                <span className="map-cap">From</span>
                <input
                  type="date"
                  value={sinceStr}
                  disabled={running}
                  onChange={(e) => setSinceStr(e.target.value)}
                />
              </label>
              <label>
                <span className="map-cap">Until</span>
                <input
                  type="date"
                  value={untilStr}
                  disabled={running}
                  onChange={(e) => setUntilStr(e.target.value)}
                />
              </label>
            </div>
            <p className="hint">
              This range takes <strong>{windowCount}</strong> Toggl request
              {windowCount === 1 ? '' : 's'} (one per 90 days) of the {HOURLY_LIMIT}/hour budget
              ({t.reqThisHour} used in the last hour). You can re-run the import safely: entries
              already imported are skipped.
            </p>

            {phase === 'setup' && (
              <button
                className="btn btn-primary"
                onClick={run}
                disabled={windowCount === 0}
              >
                Start import
              </button>
            )}

            {(running || phase === 'done' || phase === 'error') && (
              <div className="imp-progress">
                <div className="imp-bar">
                  <div className="imp-bar-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="imp-progress-line">
                  <span>
                    {progress.done}/{progress.total} windows
                  </span>
                  <span>
                    {stats.imported} imported · {stats.duplicates} already in ·{' '}
                    {stats.unmapped} skipped
                    {stats.invalid > 0 ? ` · ${stats.invalid} invalid` : ''}
                    {stats.stoppedRunning > 0 ? ` · ${stats.stoppedRunning} stopped at import` : ''}
                  </span>
                </div>
                {running && pause && (
                  <div className="imp-pause">
                    ⏸ {pause.reason} ({pauseSecs}s)
                  </div>
                )}
                {running && (
                  <button
                    className="btn"
                    onClick={() => {
                      cancelRef.current = true;
                    }}
                  >
                    Cancel
                  </button>
                )}
                {phase === 'done' && (
                  <p className="imp-done">
                    ✓ Import finished. Open the <Link href="/tracker">Tracker</Link>, or compare a
                    past week&apos;s <Link href="/timesheet">timesheet</Link> with Toggl.
                  </p>
                )}
                {phase === 'error' && runError && (
                  <div className="err-msg">
                    {runError}{' '}
                    <button className="linkbtn" onClick={run}>
                      Try again
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      <MutationToast t={t} />

      {needsPassword && <PasswordGate onSubmit={submitPassword} error={pwError} busy={pwBusy} />}

      {!needsPassword && showSettings && <AppSettings t={t} canClose />}
    </>
  );
}
