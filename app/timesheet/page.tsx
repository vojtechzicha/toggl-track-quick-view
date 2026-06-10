'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import Link from 'next/link';
import SettingsPanel, { TimesheetMode, type SettingsPreset } from '@/components/SettingsPanel';
import ProjectChips from '@/components/ProjectChips';
import PasswordGate from '@/components/PasswordGate';
import WorkspaceSwitcher from '@/components/WorkspaceSwitcher';
import SummaryTimesheet from '@/components/timesheet/SummaryTimesheet';
import IndividualTimesheet from '@/components/timesheet/IndividualTimesheet';
import ExportDialog from '@/components/export/ExportDialog';
import type { TimesheetViewProps } from '@/components/timesheet/types';
import { useToggl, applyPreset } from '@/lib/useToggl';
import { isAuthRequired } from '@/lib/toggl';
import {
  startOfWeek,
  effectiveMaxBillableHours,
  roundingUnitSeconds,
  fmtTimeOfDay,
  type TimeEntry,
} from '@/lib/calc';

const DAY_MS = 24 * 3600 * 1000;
const WEEK_MS = 7 * DAY_MS;
const PICKER_PAGE = 12; // how many previous weeks the picker reveals at a time

// One entry per timesheet view. Adding a new view is just another row here plus
// its component — the shell below stays untouched.
const VIEWS: Record<
  TimesheetMode,
  { note: (roundMins: number) => string; Component: ComponentType<TimesheetViewProps> }
> = {
  summary: {
    note: (m) => `Combined per billing tag, rounded to ${m} min · copy a cell to paste into your timesheet`,
    Component: SummaryTimesheet,
  },
  individual: {
    note: (m) => `One row per entry, with times · same-code neighbours combined, rounded to ${m} min`,
    Component: IndividualTimesheet,
  },
};

// 'current' = the live, auto-refreshing current week (free from the shared poll).
// 'picker'  = choosing a past week (no Toggl calls until one is selected).
// 'history' = a selected past week, fetched once, refreshed only on demand.
type Mode = 'current' | 'picker' | 'history';

interface CachedWeek {
  entries: TimeEntry[];
  at: number; // when these entries were fetched (for the "updated" label)
}

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
    setLivePollPaused,
    loadRange,
  } = useToggl();

  const [mode, setMode] = useState<Mode>('current');
  const [showExport, setShowExport] = useState(false);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [pickerCount, setPickerCount] = useState(PICKER_PAGE);
  const [histEntries, setHistEntries] = useState<TimeEntry[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);
  const [histLoadedAt, setHistLoadedAt] = useState(0);
  // Already-fetched past weeks, kept in memory for the session only (no
  // localStorage, by design): re-opening a week costs zero calls; Refresh forces
  // a fresh fetch that bypasses both this and the shared server cache.
  const cacheRef = useRef<Map<number, CachedWeek>>(new Map());

  const view = VIEWS[settings.timesheetMode];
  const needsPassword = serverManaged === true && passwordRequired && !authed;

  const sel = settings.selectedProjects;
  const multi = sel.length > 1;
  const hasProject = sel.length > 0;
  const projectTitle = multi ? settings.groupName || 'Multiple projects' : sel[0]?.name || 'No project';

  // Off the current week, pause the live poll so we don't keep spending the
  // hourly budget on data that isn't on screen. Resumed on return / unmount.
  useEffect(() => {
    setLivePollPaused(mode !== 'current');
    return () => setLivePollPaused(false);
  }, [mode, setLivePollPaused]);

  const loadWeek = useCallback(
    async (weekStart: number, force: boolean) => {
      if (!force) {
        const cached = cacheRef.current.get(weekStart);
        if (cached) {
          setHistEntries(cached.entries);
          setHistLoadedAt(cached.at);
          setHistError(null);
          return;
        }
      }
      setHistLoading(true);
      setHistError(null);
      try {
        const startISO = new Date(weekStart).toISOString();
        const endISO = new Date(weekStart + WEEK_MS).toISOString();
        const ent = await loadRange(startISO, endISO, { force });
        const at = Date.now();
        cacheRef.current.set(weekStart, { entries: ent, at });
        setHistEntries(ent);
        setHistLoadedAt(at);
      } catch (e) {
        setHistError(
          isAuthRequired(e)
            ? 'Session expired — return to this week to sign in again.'
            : 'Could not load this week from Toggl. Try refresh.'
        );
      } finally {
        setHistLoading(false);
      }
    },
    [loadRange]
  );

  const goCurrent = () => {
    setMode('current');
    setSelectedWeek(null);
    setHistError(null);
  };
  const goPicker = () => {
    setMode('picker');
    setPickerCount(PICKER_PAGE);
  };
  const selectWeek = (weekStart: number) => {
    setSelectedWeek(weekStart);
    setMode('history');
    loadWeek(weekStart, false);
  };
  const refresh = () => {
    if (selectedWeek != null) loadWeek(selectedWeek, true);
  };

  const fmtDay = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const weekRange = (ms: number) => `${fmtDay(ms)} – ${fmtDay(ms + 6 * DAY_MS)}`;

  const currentWeekStart = nowMs ? startOfWeek(new Date(nowMs)).getTime() : 0;
  const pickerWeeks = useMemo(() => {
    if (!currentWeekStart) return [];
    return Array.from({ length: pickerCount }, (_, i) => currentWeekStart - (i + 1) * WEEK_MS);
  }, [currentWeekStart, pickerCount]);

  // Which week + entries the body renders. History shows the selected week's
  // fetched entries; otherwise the live current-week entries from the poll.
  const shownWeekStart = mode === 'history' && selectedWeek != null ? selectedWeek : currentWeekStart;
  const shownEntries = mode === 'history' ? histEntries : entries;

  // The on-screen week's entries, ready for the export dialog to reuse (so
  // exporting the week you're looking at costs no extra Toggl request). In history
  // mode only offer it once the snapshot has actually loaded.
  const shownDataReady = mode !== 'history' || (!histLoading && !histError && histLoadedAt > 0);
  const exportPrefetched =
    hasProject && shownWeekStart > 0 && shownDataReady
      ? { fromMs: shownWeekStart, toMs: shownWeekStart + WEEK_MS, entries: shownEntries }
      : null;

  if (!hydrated) {
    return <div className="center-msg">Loading…</div>;
  }

  const Body = view.Component;

  const headerSub =
    mode === 'picker'
      ? 'Pick a previous week'
      : shownWeekStart
      ? weekRange(shownWeekStart)
      : '';

  return (
    <>
      <div className="ts-page">
        <header className="topbar">
          <div className="brand">
            <h1>Timesheet</h1>
            <p>
              {projectTitle}
              {multi && <ProjectChips projects={sel} className="chips-inline" />}
              {headerSub ? ` · ${headerSub}` : ''}
            </p>
          </div>
          <div className="topbar-actions">
            <WorkspaceSwitcher
              presets={settings.presets}
              current={settings}
              onSelect={(p) => persist(applyPreset(settings, p, projects))}
            />
            {mode === 'current' ? (
              <button className="navbtn" onClick={goPicker} aria-label="Previous weeks">
                <span className="navbtn-icon">←</span>
                <span className="navbtn-text">Previous weeks</span>
              </button>
            ) : (
              <button className="navbtn" onClick={goCurrent} aria-label="This week">
                <span className="navbtn-icon">↩</span>
                <span className="navbtn-text">This week</span>
              </button>
            )}
            {hasProject && (
              <button className="navbtn" onClick={() => setShowExport(true)} aria-label="Export">
                <span className="navbtn-icon">⤓</span>
                <span className="navbtn-text">Export</span>
              </button>
            )}
            <Link className="navbtn" href="/" aria-label="Dashboard">
              <span className="navbtn-icon">⌂</span>
              <span className="navbtn-text">Dashboard</span>
            </Link>
            <button className="iconbtn" aria-label="Settings" onClick={() => setShowSettings(true)}>
              ⚙
            </button>
          </div>
        </header>

        {mode === 'history' && (
          <div className="ts-histbar">
            <button className="navbtn ts-histbar-back" onClick={goPicker} aria-label="Back to week list">
              <span className="navbtn-icon">≡</span>
              <span className="navbtn-text">Weeks</span>
            </button>
            <span className="ts-histbar-status">
              {histLoading
                ? 'Loading…'
                : histLoadedAt
                ? `Snapshot · updated ${fmtTimeOfDay(histLoadedAt)}`
                : ''}
            </span>
            <button className="navbtn ts-refresh" onClick={refresh} disabled={histLoading}>
              <span className="navbtn-icon">↻</span>
              <span className="navbtn-text">Refresh</span>
            </button>
          </div>
        )}

        {!hasProject ? (
          <div className="center-msg" style={{ height: 'auto' }}>
            Pick a project in settings to build a timesheet.
          </div>
        ) : mode === 'picker' ? (
          <div className="ts-picker">
            <ul className="ts-week-list">
              {pickerWeeks.map((ws, i) => (
                <li key={ws}>
                  <button className="ts-week-item" onClick={() => selectWeek(ws)}>
                    <span className="ts-week-range">{weekRange(ws)}</span>
                    <span className="ts-week-rel">{i === 0 ? 'Last week' : `${i + 1} weeks ago`}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button className="navbtn ts-week-more" onClick={() => setPickerCount((c) => c + PICKER_PAGE)}>
              Show older weeks
            </button>
          </div>
        ) : mode === 'history' && histError ? (
          <div className="center-msg" style={{ height: 'auto' }}>
            <span className="err">{histError}</span>
          </div>
        ) : mode === 'history' && histLoading && histEntries.length === 0 ? (
          <div className="center-msg" style={{ height: 'auto' }}>
            Loading this week…
          </div>
        ) : (
          <Body
            entries={shownEntries}
            weekStart={shownWeekStart}
            nowMs={nowMs}
            projects={sel}
            multi={multi}
            maxBillableHours={effectiveMaxBillableHours(settings)}
            billingTagPrefix={settings.billingTagPrefix}
            roundingSeconds={roundingUnitSeconds(settings.roundingHours)}
          />
        )}

        <footer className="footer">
          <span>
            {view.note(Math.round(settings.roundingHours * 60))} ·{' '}
            {mode === 'history'
              ? 'past week · manual refresh'
              : cacheEnabled
              ? 'shared server cache'
              : 'this week'}
          </span>
        </footer>
      </div>

      {!needsPassword && showExport && hasProject && (
        <ExportDialog
          view={settings.timesheetMode}
          projects={sel}
          multi={multi}
          nowMs={nowMs}
          selectedWeekStart={shownWeekStart || null}
          maxBillableHours={effectiveMaxBillableHours(settings)}
          billingTagPrefix={settings.billingTagPrefix}
          roundingSeconds={roundingUnitSeconds(settings.roundingHours)}
          title={projectTitle}
          personName={settings.exportName.trim() || settings.accountName}
          prefetched={exportPrefetched}
          loadRange={loadRange}
          onClose={() => setShowExport(false)}
        />
      )}

      {needsPassword && <PasswordGate onSubmit={submitPassword} error={pwError} busy={pwBusy} />}

      {!needsPassword && showSettings && (
        <SettingsPanel
          initial={{
            token: settings.token,
            selectedProjects: settings.selectedProjects,
            groupName: settings.groupName,
            shortFriday: settings.shortFriday,
            weeklyHours: settings.weeklyHours,
            maxBillableHours: settings.maxBillableHours,
            minWorkingDayHours: settings.minWorkingDayHours,
            billingTagPrefix: settings.billingTagPrefix,
            roundingHours: settings.roundingHours,
            refreshSec: settings.refreshSec,
            timesheetMode: settings.timesheetMode,
            exportName: settings.exportName,
          }}
          projects={projects}
          serverManaged={!!serverManaged}
          cacheInterval={cacheEnabled ? effectiveRefreshSec : null}
          authError={authError}
          connecting={connecting}
          presets={settings.presets}
          onPresetsChange={(presets: SettingsPreset[]) => persist({ ...settings, presets })}
          onApply={(p) => persist(applyPreset(settings, p, projects))}
          onConnect={(token) => connect(token, true)}
          onSave={(v) => {
            persist({ ...settings, ...v });
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
          canClose={hasProject}
        />
      )}
    </>
  );
}
