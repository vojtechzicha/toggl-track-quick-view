'use client';

import { useState } from 'react';
import type { Project } from '@/lib/toggl';

export interface SettingsValue {
  token: string;
  projectId: number | null;
  projectName: string;
  shortFriday: boolean;
  refreshSec: number;
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

  const tokenConnected = projects.length > 0;
  const showProjects = serverManaged || tokenConnected;

  const handleSave = () => {
    const proj = projects.find((p) => p.id === projectId);
    onSave({
      // In server-managed mode the token always stays empty so the proxy uses
      // the server's TOGGL_API_TOKEN.
      token: serverManaged ? '' : token,
      projectId,
      projectName: proj?.name ?? initial.projectName,
      shortFriday,
      refreshSec,
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

        <div className="toggle">
          <div className="t-text">
            <strong>Short week</strong>
            <span>Front-load the week: 9h Mon–Wed for a lighter Friday. Off keeps an even 8h. Both aim for 40h/week.</span>
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
