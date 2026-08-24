'use client';

// One entry in the tracker list. Everything edits inline:
//  - description: click → input (Enter/blur commits)
//  - billing tag chip: click → TagCombobox popover
//  - times: click → popover with two datetime-local inputs (a running entry
//    exposes only its start; it keeps running)
//  - continue ▶ starts a new running entry copying description/tag/workspace
//  - delete asks for confirmation

import { useState } from 'react';
import TagCombobox from './TagCombobox';
import { durationSec, fromLocalInput, isRunning, toLocalInput, withBillingTag } from './util';
import { initialsOf } from '@/components/ProjectChips';
import { billingTagOf, fmtHM, fmtTimeOfDay, supportTicketCode, type TimeEntry } from '@/lib/calc';
import type { EntryInput, StoreWorkspace } from '@/lib/source/standalone';

export default function EntryRow({
  entry,
  nowMs,
  workspaces,
  prefix,
  byProject,
  showChip,
  onEdit,
  onContinue,
  onDelete,
}: {
  entry: TimeEntry;
  nowMs: number;
  workspaces: StoreWorkspace[];
  /** The billing prefix of THIS entry's workspace. */
  prefix: string;
  /** THIS entry's workspace bills by project — it has no billing tag to show. */
  byProject: boolean;
  /** Show the workspace chip (only useful once several workspaces exist). */
  showChip: boolean;
  onEdit: (id: number, patch: EntryInput) => void;
  onContinue: (entry: TimeEntry) => void;
  onDelete: (id: number) => void;
}) {
  const running = isRunning(entry);
  const startMs = Date.parse(entry.start);
  const stopMs = running ? nowMs : Date.parse(entry.stop as string);
  const tag = billingTagOf(entry.tags, prefix);
  // Support tickets: an untagged entry whose description opens with "[ticket]"
  // bills to that ticket — its chip shows the derived code (dashed) rather than
  // the missing-tag warning. An explicit tag can still be set and then wins.
  const ticket = tag === null ? supportTicketCode(entry.description) : null;
  const ws = workspaces.find((w) => w.id === entry.project_id);

  const [editDesc, setEditDesc] = useState<string | null>(null);
  const [tagOpen, setTagOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const [timeStart, setTimeStart] = useState('');
  const [timeStop, setTimeStop] = useState('');
  const [timeError, setTimeError] = useState<string | null>(null);

  const commitDesc = () => {
    if (editDesc !== null && editDesc.trim() !== (entry.description ?? '').trim()) {
      onEdit(entry.id, { description: editDesc.trim() });
    }
    setEditDesc(null);
  };

  const openTime = () => {
    setTimeStart(toLocalInput(startMs));
    setTimeStop(running ? '' : toLocalInput(stopMs));
    setTimeError(null);
    setTimeOpen(true);
  };

  const commitTime = () => {
    const s = fromLocalInput(timeStart);
    if (s === null) {
      setTimeError('Invalid start.');
      return;
    }
    const patch: EntryInput = { start: new Date(s).toISOString() };
    if (!running) {
      const e = fromLocalInput(timeStop);
      if (e === null) {
        setTimeError('Invalid end.');
        return;
      }
      if (e <= s) {
        setTimeError('End must be after start.');
        return;
      }
      patch.stop = new Date(e).toISOString();
    } else if (s > nowMs) {
      setTimeError('A running entry cannot start in the future.');
      return;
    }
    setTimeOpen(false);
    onEdit(entry.id, patch);
  };

  return (
    <div className={`tr-row${running ? ' live' : ''}`}>
      <div className="tr-main">
        {editDesc !== null ? (
          <input
            className="tr-desc-input"
            type="text"
            value={editDesc}
            autoFocus
            onChange={(e) => setEditDesc(e.target.value)}
            onBlur={commitDesc}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitDesc();
              if (e.key === 'Escape') setEditDesc(null);
            }}
          />
        ) : (
          <button
            type="button"
            className={`tr-desc${entry.description?.trim() ? '' : ' empty'}`}
            title="Edit description"
            onClick={() => setEditDesc(entry.description ?? '')}
          >
            {entry.description?.trim() || '(no description)'}
          </button>
        )}

        {/* A workspace that bills by project has no billing tag to edit —
            the workspace chip below already says what the entry bills to. */}
        {!byProject && (
        <span className="tr-tagwrap">
          {tagOpen ? (
            <TagCombobox
              value={tag}
              prefix={prefix}
              autoFocus
              onCommit={(t) => onEdit(entry.id, { tags: withBillingTag(entry.tags, prefix, t) })}
              onClose={() => setTagOpen(false)}
            />
          ) : (
            <button
              type="button"
              className={`tr-tag${tag ? '' : ticket ? ' derived' : ' missing'}`}
              title={
                tag
                  ? 'Change billing tag'
                  : ticket
                  ? `Bills to ${ticket} (support ticket from the description) — click to set an explicit tag instead`
                  : 'No billing tag — click to add one'
              }
              onClick={() => setTagOpen(true)}
            >
              {tag ?? (ticket ? `[${ticket}]` : `⚠ ${prefix}…`)}
            </button>
          )}
        </span>
        )}

        {showChip && ws && (
          <span
            className="proj-chip"
            style={ws.color ? { background: ws.color } : undefined}
            title={ws.name}
          >
            {initialsOf(ws.name)}
          </span>
        )}
      </div>

      <div className="tr-side">
        <span className="tr-timewrap">
          <button type="button" className="tr-time" title="Edit times" onClick={openTime}>
            {fmtTimeOfDay(startMs)} – {running ? 'now' : fmtTimeOfDay(stopMs)}
          </button>
          {timeOpen && (
            <span className="tr-timepop">
              <label>
                <span className="map-cap">Start</span>
                <input
                  type="datetime-local"
                  value={timeStart}
                  onChange={(e) => setTimeStart(e.target.value)}
                />
              </label>
              {!running && (
                <label>
                  <span className="map-cap">End</span>
                  <input
                    type="datetime-local"
                    value={timeStop}
                    onChange={(e) => setTimeStop(e.target.value)}
                  />
                </label>
              )}
              {timeError && <span className="addbar-err">{timeError}</span>}
              <span className="tr-timepop-btns">
                <button type="button" className="btn" onClick={() => setTimeOpen(false)}>
                  Cancel
                </button>
                <button type="button" className="btn btn-primary" onClick={commitTime}>
                  Save
                </button>
              </span>
            </span>
          )}
        </span>
        <span className={`tr-dur${running ? ' live' : ''}`}>
          {fmtHM(durationSec(entry, nowMs))}
        </span>
        <button
          type="button"
          className="ws-icon"
          title="Continue — start a new timer with this description and tag"
          onClick={() => onContinue(entry)}
        >
          ▶
        </button>
        <button
          type="button"
          className="ws-icon ws-del"
          title="Delete this entry"
          onClick={() => {
            if (window.confirm('Delete this entry? This cannot be undone.')) onDelete(entry.id);
          }}
        >
          🗑
        </button>
      </div>
    </div>
  );
}
