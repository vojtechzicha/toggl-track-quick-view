'use client';

import type { ComponentType } from 'react';
import Link from 'next/link';
import SettingsPanel, { TimesheetMode } from '@/components/SettingsPanel';
import PasswordGate from '@/components/PasswordGate';
import SummaryTimesheet from '@/components/timesheet/SummaryTimesheet';
import IndividualTimesheet from '@/components/timesheet/IndividualTimesheet';
import type { TimesheetViewProps } from '@/components/timesheet/types';
import { useToggl } from '@/lib/useToggl';
import { startOfWeekMonday } from '@/lib/calc';

const DAY_MS = 24 * 3600 * 1000;

// One entry per timesheet view. Adding a new view is just another row here plus
// its component — the shell below stays untouched.
const VIEWS: Record<TimesheetMode, { note: string; Component: ComponentType<TimesheetViewProps> }> = {
  summary: {
    note: 'Combined per billing tag, rounded to 15 min · copy a cell to paste into your timesheet',
    Component: SummaryTimesheet,
  },
  individual: {
    note: 'One row per entry, with times · same-code neighbours combined, rounded to 15 min',
    Component: IndividualTimesheet,
  },
};

export default function TimesheetPage() {
  const {
    hydrated,
    settings,
    persist,
    projects,
    serverManaged,
    passwordRequired,
    authed,
    pwError,
    pwBusy,
    submitPassword,
    connecting,
    authError,
    connect,
    entries,
    nowMs,
    cacheEnabled,
    effectiveRefreshSec,
    showSettings,
    setShowSettings,
  } = useToggl();

  const view = VIEWS[settings.timesheetMode];
  const needsPassword = serverManaged === true && passwordRequired && !authed;

  if (!hydrated) {
    return <div className="center-msg">Loading…</div>;
  }

  const fmtDay = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const weekStartMs = nowMs ? startOfWeekMonday(new Date(nowMs)).getTime() : 0;
  const weekRange = weekStartMs ? `${fmtDay(weekStartMs)} – ${fmtDay(weekStartMs + 6 * DAY_MS)}` : '';

  const Body = view.Component;

  return (
    <>
      <div className="ts-page">
        <header className="topbar">
          <div className="brand">
            <h1>Timesheet</h1>
            <p>
              {settings.projectName || 'No project'}
              {weekRange ? ` · ${weekRange}` : ''}
            </p>
          </div>
          <div className="topbar-actions">
            <Link className="navbtn" href="/" aria-label="Dashboard">
              <span className="navbtn-icon">←</span>
              <span className="navbtn-text">Dashboard</span>
            </Link>
            <button className="iconbtn" aria-label="Settings" onClick={() => setShowSettings(true)}>
              ⚙
            </button>
          </div>
        </header>

        {!settings.projectId ? (
          <div className="center-msg" style={{ height: 'auto' }}>
            Pick a project in settings to build a timesheet.
          </div>
        ) : (
          <Body
            entries={entries}
            nowMs={nowMs}
            projectId={settings.projectId}
            projectName={settings.projectName}
          />
        )}

        <footer className="footer">
          <span>
            {view.note} · {cacheEnabled ? 'shared server cache' : 'this week'}
          </span>
        </footer>
      </div>

      {needsPassword && <PasswordGate onSubmit={submitPassword} error={pwError} busy={pwBusy} />}

      {!needsPassword && showSettings && (
        <SettingsPanel
          initial={{
            token: settings.token,
            projectId: settings.projectId,
            projectName: settings.projectName,
            shortFriday: settings.shortFriday,
            refreshSec: settings.refreshSec,
            timesheetMode: settings.timesheetMode,
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
