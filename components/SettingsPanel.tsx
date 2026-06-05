'use client';

import { useState } from 'react';
import type { Project } from '@/lib/toggl';
import {
  DEFAULT_WEEKLY_HOURS,
  defaultMaxBillableHours,
  defaultMinWorkingDayHours,
  fmtHoursLabel,
} from '@/lib/calc';

export type TimesheetMode = 'summary' | 'individual';

export interface SettingsValue {
  token: string;
  projectId: number | null;
  projectName: string;
  shortFriday: boolean;
  // The master weekly target (hours). Scales the whole targets model; default 40.
  weeklyHours: number;
  // Advanced overrides. null = follow the weekly value proportionally; a number =
  // that absolute hours value, which stays put when weeklyHours later changes.
  maxBillableHours: number | null;
  minWorkingDayHours: number | null;
  refreshSec: number;
  timesheetMode: TimesheetMode;
}

const WEEKLY_MIN = 1;
const WEEKLY_MAX = 80;
const STEP = 0.25; // 15-minute granularity for every hours field

/** Round to the nearest quarter-hour and keep it within [min, max]. */
function clampQuarter(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n / STEP) * STEP));
}

/** A compact numeric label without a trailing "h", e.g. 4 → "4", 2.5 → "2.5". */
function numLabel(n: number): string {
  return String(Number(n.toFixed(2)));
}

// Each option's implied requests/hour, so the user can see the budget impact
// (Toggl Free allows 30/hour).
const REFRESH_OPTIONS = [
  { sec: 60, label: '1 min — ~60/hr (paid plans only)' },
  { sec: 120, label: '2 min — ~30/hr (at the Free limit)' },
  { sec: 180, label: '3 min — ~20/hr (recommended)' },
  { sec: 300, label: '5 min — ~12/hr (conservative)' },
  { sec: 600, label: '10 min — ~6/hr' },
];

function fmtInterval(sec: number): string {
  return sec % 60 === 0 ? `${sec / 60} min` : `${sec}s`;
}

export default function SettingsPanel({
  initial,
  projects,
  serverManaged,
  cacheInterval,
  authError,
  connecting,
  onConnect,
  onSave,
  onClose,
  canClose,
}: {
  initial: SettingsValue;
  projects: Project[];
  serverManaged: boolean;
  // When non-null, the shared server cache governs the refresh cadence (in
  // seconds) and the per-device refresh picker is hidden.
  cacheInterval: number | null;
  authError: string | null;
  connecting: boolean;
  onConnect: (token: string) => void;
  onSave: (value: SettingsValue) => void;
  onClose: () => void;
  canClose: boolean;
}) {
  const [token, setToken] = useState(initial.token);
  const [projectId, setProjectId] = useState<number | null>(initial.projectId);
  const [shortFriday, setShortFriday] = useState(initial.shortFriday);
  const [refreshSec, setRefreshSec] = useState(initial.refreshSec);
  const [timesheetMode, setTimesheetMode] = useState<TimesheetMode>(initial.timesheetMode);

  // Hours fields are kept as raw strings so a half-typed value (e.g. "3.") never
  // snaps mid-edit; they're parsed and clamped on save. An empty advanced field
  // means "auto" (null) — it then follows the weekly value proportionally.
  const [weeklyStr, setWeeklyStr] = useState(numLabel(initial.weeklyHours));
  const [maxBillStr, setMaxBillStr] = useState(
    initial.maxBillableHours === null ? '' : numLabel(initial.maxBillableHours)
  );
  const [minDayStr, setMinDayStr] = useState(
    initial.minWorkingDayHours === null ? '' : numLabel(initial.minWorkingDayHours)
  );
  const [showAdvanced, setShowAdvanced] = useState(
    initial.maxBillableHours !== null || initial.minWorkingDayHours !== null
  );

  const tokenConnected = projects.length > 0;
  const showProjects = serverManaged || tokenConnected;

  // The weekly value currently being edited (clamped), used to live-preview the
  // proportional defaults shown as placeholders in the advanced fields.
  const parsedWeekly = parseFloat(weeklyStr);
  const previewWeekly = Number.isFinite(parsedWeekly)
    ? clampQuarter(parsedWeekly, WEEKLY_MIN, WEEKLY_MAX)
    : DEFAULT_WEEKLY_HOURS;

  const handleSave = () => {
    const proj = projects.find((p) => p.id === projectId);
    const weeklyHours = previewWeekly;
    // An empty (or unparseable) advanced field is "auto" (null); otherwise clamp
    // the override to a quarter-hour within [min, weeklyHours]. The Friday floor
    // may be set to 0 ("no floor — show whatever's actually left, even nothing"),
    // but the billable cap keeps a quarter-hour minimum (a 0h cap is meaningless).
    const parseOverride = (s: string, min: number): number | null => {
      const n = parseFloat(s);
      if (s.trim() === '' || !Number.isFinite(n)) return null;
      return clampQuarter(n, min, weeklyHours);
    };
    onSave({
      // In server-managed mode the token always stays empty so the proxy uses
      // the server's TOGGL_API_TOKEN.
      token: serverManaged ? '' : token,
      projectId,
      projectName: proj?.name ?? initial.projectName,
      shortFriday,
      weeklyHours,
      maxBillableHours: parseOverride(maxBillStr, STEP),
      minWorkingDayHours: parseOverride(minDayStr, 0),
      refreshSec,
      timesheetMode,
    });
  };

  return (
    <div className="overlay">
      <div className="panel">
        <h2>Settings</h2>

        {serverManaged ? (
          <p className="hint">
            The Toggl API token is configured on the server, so there&apos;s nothing to enter
            here. Just pick your project below.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="token">Toggl Track API token</label>
              <input
                id="token"
                type="password"
                value={token}
                placeholder="Paste your API token"
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
              <p className="hint">
                Find it at{' '}
                <a href="https://track.toggl.com/profile" target="_blank" rel="noreferrer">
                  track.toggl.com/profile
                </a>{' '}
                (bottom of the page). It is stored only in this browser and sent through this
                app&apos;s own proxy.
              </p>
            </div>

            <div className="row" style={{ justifyContent: 'flex-start' }}>
              <button
                className="btn"
                onClick={() => onConnect(token)}
                disabled={!token || connecting}
              >
                {connecting ? 'Connecting…' : tokenConnected ? 'Reconnect' : 'Connect'}
              </button>
            </div>
          </>
        )}

        {authError && <div className="err-msg">{authError}</div>}

        {showProjects && (
          <div className="field">
            <label htmlFor="project">Project</label>
            <select
              id="project"
              value={projectId ?? ''}
              onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Select a project…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {showProjects && (
          <div className="field">
            <label htmlFor="timesheet-mode">Timesheet view</label>
            <select
              id="timesheet-mode"
              value={timesheetMode}
              onChange={(e) => setTimesheetMode(e.target.value as TimesheetMode)}
            >
              <option value="summary">Summary — combined per billing tag</option>
              <option value="individual">Individual — one row per entry</option>
            </select>
            <p className="hint">
              Which view the Timesheet button opens. Summary groups each day&apos;s entries by
              billing tag and rounds to 15 minutes; Individual lists entries one by one.
            </p>
          </div>
        )}

        <div className="toggle">
          <div className="t-text">
            <strong>Short week</strong>
            <span>
              Front-load the week: {fmtHoursLabel((9 * previewWeekly) / 40)} Mon–Wed for a lighter
              Friday. Off keeps an even {fmtHoursLabel(previewWeekly / 5)}. Both aim for{' '}
              {fmtHoursLabel(previewWeekly)}/week.
            </span>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              checked={shortFriday}
              onChange={(e) => setShortFriday(e.target.checked)}
            />
            <span className="slider" />
          </label>
        </div>

        <div className="field">
          <label htmlFor="weekly-hours">Hours worked per week</label>
          <input
            id="weekly-hours"
            type="number"
            inputMode="decimal"
            min={WEEKLY_MIN}
            max={WEEKLY_MAX}
            step={STEP}
            value={weeklyStr}
            onChange={(e) => setWeeklyStr(e.target.value)}
          />
          <p className="hint">
            The whole week&apos;s target. Defaults to 40h; set it lower for a part-time project (or
            higher) and every target, floor and cap rescales proportionally — e.g. a 20h week
            becomes an even 4h/day. The break reminder is unaffected.
          </p>
        </div>

        <details className="advanced" open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced targets</summary>

          <div className="field">
            <label htmlFor="max-billable">Maximal individually billed timesheet</label>
            <input
              id="max-billable"
              type="number"
              inputMode="decimal"
              min={STEP}
              max={previewWeekly}
              step={STEP}
              value={maxBillStr}
              placeholder={numLabel(defaultMaxBillableHours(previewWeekly))}
              onChange={(e) => setMaxBillStr(e.target.value)}
            />
            <p className="hint">
              A single entry longer than this can&apos;t be billed as one line — the timesheet flags
              it to split in Toggl. Leave blank to auto-scale with the week (currently{' '}
              <strong>{fmtHoursLabel(defaultMaxBillableHours(previewWeekly))}</strong>).
            </p>
          </div>

          <div className="field">
            <label htmlFor="min-working-day">Minimal target working day</label>
            <input
              id="min-working-day"
              type="number"
              inputMode="decimal"
              min={0}
              max={previewWeekly}
              step={STEP}
              value={minDayStr}
              placeholder={numLabel(defaultMinWorkingDayHours(previewWeekly))}
              onChange={(e) => setMinDayStr(e.target.value)}
            />
            <p className="hint">
              The Friday floor: once the week is nearly done, the day&apos;s target never drops
              below this (so a stray hour isn&apos;t worth a trip in). Set <strong>0</strong> for no
              floor — Friday then shows exactly what&apos;s left, or nothing once you&apos;re over.
              Leave blank to auto-scale with the week (currently{' '}
              <strong>{fmtHoursLabel(defaultMinWorkingDayHours(previewWeekly))}</strong>).
            </p>
          </div>
        </details>

        {cacheInterval !== null ? (
          <div className="field">
            <label>Refresh interval</label>
            <p className="hint">
              Managed by the server: a shared cache refreshes from Toggl every{' '}
              <strong>{fmtInterval(cacheInterval)}</strong> and serves every device from it, so
              opening this on extra devices/tabs costs no additional API requests. The on-screen
              counter still updates every second between refreshes.
            </p>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="refresh">Refresh interval</label>
            <select
              id="refresh"
              value={refreshSec}
              onChange={(e) => setRefreshSec(Number(e.target.value))}
            >
              {REFRESH_OPTIONS.map((o) => (
                <option key={o.sec} value={o.sec}>
                  {o.label}
                </option>
              ))}
            </select>
            <p className="hint">
              How often to fetch from Toggl. The on-screen counter still updates every second
              between refreshes. Toggl&apos;s Free plan allows 30 requests/hour.
            </p>
          </div>
        )}

        <div className="row">
          {canClose && (
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="btn btn-primary" onClick={handleSave} disabled={!projectId}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
