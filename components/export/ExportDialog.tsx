'use client';

import { useMemo, useState } from 'react';
import type { SelectedProject } from '@/components/SettingsPanel';
import type { TimesheetMode } from '@/components/SettingsPanel';
import type { TimeEntry } from '@/lib/calc';
import { isAuthRequired, isRateLimit } from '@/lib/toggl';
import {
  type ExportPreset,
  PRESET_LABELS,
  resolvePreset,
  rangeFromInputs,
  toDateInput,
} from '@/lib/export/range';
import { buildExportDoc } from '@/lib/export/model';
import {
  type ExportFormat,
  FORMAT_LABELS,
  runExport,
} from '@/lib/export';
import { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID } from '@/lib/export/pdf';

// The presets offered in the dropdown, in order. "custom" is added automatically
// once the user edits a date by hand.
const PRESETS: ExportPreset[] = [
  'current-week',
  'selected-week',
  'current-month',
  'last-month',
  'selected-month',
];

export interface ExportDialogProps {
  view: TimesheetMode;
  projects: SelectedProject[];
  multi: boolean;
  /** Live entries (current week) — used only as a fallback; the dialog fetches its own range. */
  nowMs: number;
  /** Saturday-start of the week currently shown on the page (anchors "selected week"). */
  selectedWeekStart: number | null;
  maxBillableHours: number;
  billingTagPrefix: string;
  /** Rounding granularity in seconds (900 = 15 min default, 720 = 12 min). */
  roundingSeconds: number;
  /** Document title (project / group name). */
  title: string;
  /** Person the timesheet is for (resolved name, may be empty). */
  personName: string;
  /**
   * Entries already in memory (the week currently on screen) and the half-open
   * range they fully cover. When the requested export range fits inside this, the
   * dialog reuses them instead of spending another Toggl request.
   */
  prefetched: { fromMs: number; toMs: number; entries: TimeEntry[] } | null;
  loadRange: (startISO: string, endISO: string, opts?: { force?: boolean }) => Promise<TimeEntry[]>;
  onClose: () => void;
}

export default function ExportDialog({
  view,
  projects,
  multi,
  nowMs,
  selectedWeekStart,
  maxBillableHours,
  billingTagPrefix,
  roundingSeconds,
  title,
  personName,
  prefetched,
  loadRange,
  onClose,
}: ExportDialogProps) {
  const [preset, setPreset] = useState<ExportPreset>('current-month');
  const initial = useMemo(
    () => resolvePreset('current-month', nowMs, selectedWeekStart),
    // Seed once on mount; later preset changes update the inputs explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [fromStr, setFromStr] = useState(() => toDateInput(initial.fromMs));
  const [toStr, setToStr] = useState(() => toDateInput(initial.toMs - 1)); // inclusive last day
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  const [name, setName] = useState(personName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const applyPreset = (p: ExportPreset) => {
    setPreset(p);
    setDone(null);
    if (p === 'custom') return;
    const r = resolvePreset(p, nowMs, selectedWeekStart);
    setFromStr(toDateInput(r.fromMs));
    setToStr(toDateInput(r.toMs - 1));
  };

  const editFrom = (v: string) => {
    setFromStr(v);
    setPreset('custom');
    setDone(null);
  };
  const editTo = (v: string) => {
    setToStr(v);
    setPreset('custom');
    setDone(null);
  };

  const rangeValid = rangeFromInputs(fromStr, toStr) != null;

  const handleExport = async () => {
    const range = rangeFromInputs(fromStr, toStr);
    if (!range) {
      setError('Pick a valid date range — the “to” date must be on or after the “from” date.');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      // Reuse the on-screen week's entries when they already cover the request
      // (e.g. exporting the very week you're viewing); otherwise fetch the range,
      // which goes through the shared server cache when one is configured.
      const covered =
        prefetched != null &&
        range.fromMs >= prefetched.fromMs &&
        range.toMs <= prefetched.toMs;
      const entries = covered
        ? (prefetched as NonNullable<typeof prefetched>).entries
        : await loadRange(new Date(range.fromMs).toISOString(), new Date(range.toMs).toISOString());
      const doc = buildExportDoc({
        view,
        range,
        entries,
        nowMs,
        projects,
        multi,
        maxBillableHours,
        billingTagPrefix,
        roundingSeconds,
        title,
        personName: name.trim(),
      });
      const ok = await runExport(doc, format, templateId);
      if (!ok) {
        setError('No entries in this range — nothing to export.');
        return;
      }
      setDone(`Exported as ${FORMAT_LABELS[format]}.`);
    } catch (e) {
      if (isAuthRequired(e)) {
        setError('Session expired — return to the timesheet to sign in again, then retry.');
      } else if (isRateLimit(e)) {
        setError('Toggl rate limit reached — wait a moment, then try again.');
      } else {
        setError('Could not load this range from Toggl. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const viewLabel = view === 'summary' ? 'Summary' : 'Individual';

  return (
    <div className="overlay">
      <div className="panel">
        <h2>Export timesheet</h2>
        <p className="hint">
          Exports the <strong>{viewLabel}</strong> view exactly as shown — same
          rounding and grouping, not the raw Toggl entries.
        </p>

        <div className="field">
          <label htmlFor="exp-preset">Range</label>
          <select
            id="exp-preset"
            value={preset}
            onChange={(e) => applyPreset(e.target.value as ExportPreset)}
          >
            {PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_LABELS[p]}
              </option>
            ))}
            {preset === 'custom' && <option value="custom">{PRESET_LABELS.custom}</option>}
          </select>
        </div>

        <div className="exp-dates">
          <div className="field">
            <label htmlFor="exp-from">From</label>
            <input id="exp-from" type="date" value={fromStr} onChange={(e) => editFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="exp-to">To</label>
            <input id="exp-to" type="date" value={toStr} onChange={(e) => editTo(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label htmlFor="exp-format">Format</label>
          <select
            id="exp-format"
            value={format}
            onChange={(e) => {
              setFormat(e.target.value as ExportFormat);
              setDone(null);
            }}
          >
            {(Object.keys(FORMAT_LABELS) as ExportFormat[]).map((f) => (
              <option key={f} value={f}>
                {FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </div>

        {format === 'pdf' && (
          <div className="field">
            <label htmlFor="exp-name">Name on PDF</label>
            <input
              id="exp-name"
              type="text"
              value={name}
              placeholder="Defaults to your Toggl account name"
              onChange={(e) => {
                setName(e.target.value);
                setDone(null);
              }}
            />
          </div>
        )}

        {format === 'pdf' && PDF_TEMPLATES.length > 1 && (
          <div className="field">
            <label htmlFor="exp-template">PDF template</label>
            <select id="exp-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {PDF_TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <p className="hint">{PDF_TEMPLATES.find((t) => t.id === templateId)?.description}</p>
          </div>
        )}

        {error && <div className="err-msg">{error}</div>}
        {done && <div className="exp-done">✓ {done}</div>}

        <div className="row">
          <button className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button className="btn btn-primary" onClick={handleExport} disabled={busy || !rangeValid}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
