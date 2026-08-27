'use client';

// The tracker's sticky top bar. Two shapes:
//  - idle: description + billing-tag combobox + workspace selector, in TIMER
//    mode (big Start button) or MANUAL mode (start/end datetime-locals + Add).
//  - running: the bar becomes the running strip — live H:MM:SS, description
//    and tag editable in place, Stop button.

import { useEffect, useState } from 'react';
import TagCombobox from './TagCombobox';
import { billsByProject, fromLocalInput, prefixFor, toLocalInput, withBillingTag } from './util';
import { billingTagOf, fmtClock, type TimeEntry } from '@/lib/calc';
import type { EntryInput, StoreWorkspace } from '@/lib/source/standalone';

export default function AddBar({
  workspaces,
  defaultWorkspaceId,
  running,
  nowMs,
  onStart,
  onStop,
  onAdd,
  onEditRunning,
}: {
  workspaces: StoreWorkspace[];
  defaultWorkspaceId: number;
  running: TimeEntry | null;
  nowMs: number;
  onStart: (input: { description: string; tags: string[]; workspaceId: number }) => void;
  onStop: (id: number) => void;
  /** Resolves true when the entry was created (so the form can reset). */
  onAdd: (input: {
    description: string;
    tags: string[];
    workspaceId: number;
    start: string;
    stop: string;
  }) => Promise<boolean>;
  onEditRunning: (id: number, patch: EntryInput) => void;
}) {
  const [desc, setDesc] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [wsId, setWsId] = useState(defaultWorkspaceId);
  const [manual, setManual] = useState(false);
  const [manualStart, setManualStart] = useState('');
  const [manualStop, setManualStop] = useState('');
  const [manualError, setManualError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The running strip edits the entry itself; local state so typing doesn't
  // fight the 1s re-render, re-seeded whenever a different entry runs.
  const [runDesc, setRunDesc] = useState('');
  useEffect(() => {
    setRunDesc(running?.description ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running?.id]);

  useEffect(() => {
    if (!workspaces.some((w) => w.id === wsId)) setWsId(defaultWorkspaceId);
  }, [defaultWorkspaceId, workspaces, wsId]);

  const wsSelect = workspaces.length > 1 && (
    <select
      className="addbar-ws"
      value={wsId}
      onChange={(e) => setWsId(Number(e.target.value))}
      aria-label="Workspace"
    >
      {workspaces.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );

  // A workspace that bills by project has no billing tags: the tag box goes
  // away and nothing tags what is created here.
  const byProject = billsByProject(workspaces, wsId);

  if (running) {
    const runPrefix = prefixFor(workspaces, running.project_id);
    const runByProject = billsByProject(workspaces, running.project_id);
    const elapsed = Math.max(0, (nowMs - Date.parse(running.start)) / 1000);
    return (
      <div className="addbar running">
        <input
          className="addbar-desc"
          type="text"
          value={runDesc}
          placeholder="(no description)"
          onChange={(e) => setRunDesc(e.target.value)}
          onBlur={() => {
            if (runDesc.trim() !== (running.description ?? '').trim()) {
              onEditRunning(running.id, { description: runDesc.trim() });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        {!runByProject && (
          <TagCombobox
            value={billingTagOf(running.tags, runPrefix)}
            prefix={runPrefix}
            onCommit={(t) =>
              onEditRunning(running.id, {
                tags: withBillingTag(running.tags, runPrefix, t),
              })
            }
          />
        )}
        <span className="addbar-clock">{fmtClock(elapsed)}</span>
        <button className="btn btn-stop" onClick={() => onStop(running.id)}>
          ■ Stop
        </button>
      </div>
    );
  }

  // A tag picked before switching to a bills-by-project workspace must not ride
  // along — that workspace's entries carry no billing tag.
  const tagsToSave = () => (tag && !byProject ? [tag] : []);

  const startTimer = () => {
    onStart({ description: desc.trim(), tags: tagsToSave(), workspaceId: wsId });
    setDesc('');
    setTag(null);
  };

  const addManual = async () => {
    const startMs = fromLocalInput(manualStart);
    const stopMs = fromLocalInput(manualStop);
    if (startMs === null || stopMs === null) {
      setManualError('Enter both start and end.');
      return;
    }
    if (stopMs <= startMs) {
      setManualError('End must be after start.');
      return;
    }
    setManualError(null);
    setBusy(true);
    const ok = await onAdd({
      description: desc.trim(),
      tags: tagsToSave(),
      workspaceId: wsId,
      start: new Date(startMs).toISOString(),
      stop: new Date(stopMs).toISOString(),
    });
    setBusy(false);
    if (ok) {
      setDesc('');
      setTag(null);
      // Chain the next manual entry from where this one ended.
      setManualStart(manualStop);
      setManualStop('');
    }
  };

  const enterManual = () => {
    setManual(true);
    if (!manualStart) setManualStart(toLocalInput(nowMs - 3600 * 1000));
    if (!manualStop) setManualStop(toLocalInput(nowMs));
  };

  return (
    <div className="addbar">
      <input
        className="addbar-desc"
        type="text"
        value={desc}
        placeholder="What are you working on?"
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !manual) startTimer();
        }}
      />
      {!byProject && (
        <TagCombobox key={tag ?? ''} value={tag} prefix={prefixFor(workspaces, wsId)} onCommit={setTag} />
      )}
      {wsSelect}
      {manual ? (
        <>
          <input
            className="addbar-dt"
            type="datetime-local"
            value={manualStart}
            onChange={(e) => setManualStart(e.target.value)}
            aria-label="Start"
          />
          <span className="addbar-arrow">→</span>
          <input
            className="addbar-dt"
            type="datetime-local"
            value={manualStop}
            onChange={(e) => setManualStop(e.target.value)}
            aria-label="End"
          />
          <button className="btn btn-primary" onClick={addManual} disabled={busy}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </>
      ) : (
        <button className="btn btn-start" onClick={startTimer}>
          ▶ Start
        </button>
      )}
      <div className="addbar-mode" role="tablist" aria-label="Entry mode">
        <button
          role="tab"
          aria-selected={!manual}
          className={`mode-tab${manual ? '' : ' active'}`}
          title="Timer"
          onClick={() => setManual(false)}
        >
          ⏱
        </button>
        <button
          role="tab"
          aria-selected={manual}
          className={`mode-tab${manual ? ' active' : ''}`}
          title="Manual entry"
          onClick={enterManual}
        >
          ＋
        </button>
      </div>
      {manual && manualError && <div className="addbar-err">{manualError}</div>}
    </div>
  );
}
