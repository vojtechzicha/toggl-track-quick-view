'use client';

import { useState } from 'react';
import type { Project } from '@/lib/toggl';

export interface SettingsValue {
  token: string;
  projectId: number | null;
  projectName: string;
  shortFriday: boolean;
}

export default function SettingsPanel({
  initial,
  projects,
  authError,
  connecting,
  onConnect,
  onSave,
  onClose,
  canClose,
}: {
  initial: SettingsValue;
  projects: Project[];
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

  const tokenConnected = projects.length > 0;

  const handleSave = () => {
    const proj = projects.find((p) => p.id === projectId);
    onSave({
      token,
      projectId,
      projectName: proj?.name ?? initial.projectName,
      shortFriday,
    });
  };

  return (
    <div className="overlay">
      <div className="panel">
        <h2>Settings</h2>

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

        {authError && <div className="err-msg">{authError}</div>}

        {tokenConnected && (
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
            <strong>Short Friday</strong>
            <span>9h Mon–Wed, then Thu/Fri rebalance toward a ~5h Friday (40h/week).</span>
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
