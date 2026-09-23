'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import Link from 'next/link';
import { type TimesheetMode } from '@/components/SettingsPanel';
import AppSettings from '@/components/AppSettings';
import LastUpdated from '@/components/LastUpdated';
import MutationToast from '@/components/MutationToast';
import ProjectChips from '@/components/ProjectChips';
import PasswordGate from '@/components/PasswordGate';
import SummaryTimesheet from '@/components/timesheet/SummaryTimesheet';
import IndividualTimesheet from '@/components/timesheet/IndividualTimesheet';
import ExportDialog from '@/components/export/ExportDialog';
import type { TimesheetViewProps } from '@/components/timesheet/types';
import { useTrackSource } from '@/lib/useTrackSource';
import { isAuthRequired } from '@/lib/source/errors';
import {
  addDays,
  startOfWeek,
  effectiveMaxBillableHours,
  roundingUnitSeconds,
  startWindowUnitSeconds,
  fmtTimeOfDay,
  type TimeEntry,
} from '@/lib/calc';

const PICKER_PAGE = 12; // previous weeks shown per page of the picker

// One entry per timesheet view. The note mentions the start-time window only
// when it is coarser than the rounding unit, because lines then have gaps.
const VIEWS: Record<
  TimesheetMode,
  {
    note: (roundMins: number, windowMins: number, byProject: boolean) => string;
    Component: ComponentType<TimesheetViewProps>;
  }
> = {
  summary: {
    note: (m, _w, byProject) =>
      `One cell per ${byProject ? 'project' : 'billing tag'} and day, rounded to ${m} min · copy a cell to paste into your timesheet`,
    Component: SummaryTimesheet,
  },
  individual: {
    note: (m, w, byProject) =>
      `One row per entry · adjacent same-${byProject ? 'project' : 'code'} entries combined · rounded to ${m} min` +
      (w > m ? ` · starts every ${w} min` : ''),
    Component: IndividualTimesheet,
  },
};

// 'current' = this week, from the live poll.
// 'picker'  = choosing a past week (nothing is fetched until one is picked).
// 'history' = a past week, fetched once and refreshed only on demand.
type Mode = 'current' | 'picker' | 'history';

interface CachedWeek {
  entries: TimeEntry[];
  // When the source produced these entries. A server-cache hit reports the
  // original fetch time.
  at: number;
}

export default function TimesheetPage() {
  const t = useTrackSource();
  const {
    hydrated,
    mode: sourceMode,
    settings,
    serverManaged,
    passwordRequired,
    authed,
    pwError,
    pwBusy,
    submitPassword,
    entries,
    lastUpdatedMs,
    nowMs,
    cacheEnabled,
    effectiveRefreshSec,
    showSettings,
    setShowSettings,
    setLivePollPaused,
    loadRange,
  } = t;
  const standalone = sourceMode === 'standalone';

  const [mode, setMode] = useState<Mode>('current');
  const [showExport, setShowExport] = useState(false);
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [pickerCount, setPickerCount] = useState(PICKER_PAGE);
  const [histEntries, setHistEntries] = useState<TimeEntry[]>([]);
  const [histLoading, setHistLoading] = useState(false);
  const [histError, setHistError] = useState<string | null>(null);
  const [histLoadedAt, setHistLoadedAt] = useState(0);
  // Past weeks already fetched, in memory only. Reopening a week makes no
  // request; Refresh bypasses this and the server cache.
  const cacheRef = useRef<Map<number, CachedWeek>>(new Map());

  const view = VIEWS[settings.timesheetMode];
  const needsPassword = serverManaged === true && passwordRequired && !authed;

  const startWindowSeconds = startWindowUnitSeconds(
    settings.startWindowHours,
    roundingUnitSeconds(settings.roundingHours)
  );

  const sel = settings.selectedProjects;
  const multi = sel.length > 1;
  const hasProject = sel.length > 0;
  const projectTitle = multi ? settings.groupName || 'Multiple projects' : sel[0]?.name || 'No project';

  // Pause the live poll away from the current week, to save the hourly request
  // budget. Resumed on return or unmount.
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
        const endISO = new Date(addDays(weekStart, 7)).toISOString();
        const { entries: ent, dataAtMs } = await loadRange(startISO, endISO, { force });
        const at = dataAtMs ?? Date.now();
        cacheRef.current.set(weekStart, { entries: ent, at });
        setHistEntries(ent);
        setHistLoadedAt(at);
      } catch (e) {
        setHistError(
          isAuthRequired(e)
            ? 'Session expired. Go back to this week to sign in again.'
            : 'Could not load this week. Try Refresh.'
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
  const weekRange = (ms: number) => `${fmtDay(ms)} – ${fmtDay(addDays(ms, 6))}`;

  const currentWeekStart = nowMs ? startOfWeek(new Date(nowMs)).getTime() : 0;
  const pickerWeeks = useMemo(() => {
    if (!currentWeekStart) return [];
    return Array.from({ length: pickerCount }, (_, i) => addDays(currentWeekStart, -7 * (i + 1)));
  }, [currentWeekStart, pickerCount]);

  const shownWeekStart = mode === 'history' && selectedWeek != null ? selectedWeek : currentWeekStart;
  const shownEntries = mode === 'history' ? histEntries : entries;

  // Hand the shown week to the export dialog so exporting it needs no request.
  // In history mode, only once it has loaded.
  const shownDataReady = mode !== 'history' || (!histLoading && !histError && histLoadedAt > 0);
  const exportPrefetched =
    hasProject && shownWeekStart > 0 && shownDataReady
      ? { fromMs: shownWeekStart, toMs: addDays(shownWeekStart, 7), entries: shownEntries }
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
            {standalone && (
              <Link className="navbtn" href="/tracker" aria-label="Tracker">
                <span className="navbtn-icon">⏱</span>
                <span className="navbtn-text">Tracker</span>
              </Link>
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
            startWindowSeconds={startWindowSeconds}
            maxDescriptionLength={settings.maxDescriptionLength}
            noOvertime={settings.noOvertime}
            weeklyHours={settings.weeklyHours}
            timeOffTag={settings.timeOffTag}
            codeMappings={settings.codeMappings}
            stripCodeParens={settings.stripCodeParens}
            billByProject={settings.billByProject}
          />
        )}

        <footer className="footer">
          <span>
            {view.note(
              Math.round(settings.roundingHours * 60),
              Math.round(startWindowSeconds / 60),
              settings.billByProject
            )}{' '}
            ·{' '}
            {mode === 'history'
              ? 'past week · manual refresh'
              : cacheEnabled
              ? 'shared server cache'
              : 'this week'}
            <LastUpdated
              lastUpdatedMs={mode === 'history' ? histLoadedAt : lastUpdatedMs}
              nowMs={nowMs}
              refreshSec={mode === 'history' ? null : effectiveRefreshSec}
            />
          </span>
        </footer>
      </div>

      {!needsPassword && showExport && hasProject && (
        <ExportDialog
          // The dialog reads its fields from settings on mount. Remount it when
          // synced settings arrive from another device, or the next export
          // writes the old values back.
          key={t.sync.appliedEpoch}
          view={settings.timesheetMode}
          projects={sel}
          multi={multi}
          nowMs={nowMs}
          selectedWeekStart={shownWeekStart || null}
          maxBillableHours={effectiveMaxBillableHours(settings)}
          billingTagPrefix={settings.billingTagPrefix}
          roundingSeconds={roundingUnitSeconds(settings.roundingHours)}
          startWindowSeconds={startWindowSeconds}
          maxDescriptionLength={settings.maxDescriptionLength}
          noOvertime={settings.noOvertime}
          weeklyHours={settings.weeklyHours}
          timeOffTag={settings.timeOffTag}
          codeMappings={settings.codeMappings}
          stripCodeParens={settings.stripCodeParens}
          billByProject={settings.billByProject}
          title={projectTitle}
          personName={settings.exportName.trim() || settings.accountName}
          prefetched={exportPrefetched}
          loadRange={loadRange}
          fields={settings.exportFields}
          onFieldsChange={t.setExportFields}
          fieldsScope={t.activeWorkspace?.name ?? ''}
          onClose={() => setShowExport(false)}
        />
      )}

      <MutationToast t={t} />

      {needsPassword && <PasswordGate onSubmit={submitPassword} error={pwError} busy={pwBusy} />}

      {!needsPassword && showSettings && <AppSettings t={t} canClose={hasProject} />}
    </>
  );
}
