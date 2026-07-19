'use client';

import { useMemo, useState } from 'react';
import type { SelectedProject } from '@/components/SettingsPanel';
import type { TimesheetMode } from '@/components/SettingsPanel';
import type { TimeEntry } from '@/lib/calc';
import { isAuthRequired, isRateLimit } from '@/lib/source/errors';
import {
  type ExportPreset,
  PRESET_LABELS,
  resolvePreset,
  rangeFromInputs,
  toDateInput,
} from '@/lib/export/range';
import { buildExportDoc } from '@/lib/export/model';
import type { CodeMapping } from '@/lib/timesheet/mapping';
import {
  type ExportFormat,
  FORMAT_LABELS,
  runExport,
} from '@/lib/export';
import { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID } from '@/lib/export/pdf';
import { ENGAGEMENT_PLACEHOLDERS, ENGAGEMENT_LABELS } from '@/lib/export/pdf/report';

// Identity fields some PDF templates print (role / company / client / approver /
// rate). Their values are user-entered and remembered per device — the app itself
// ships no company names or rates.
const ROLE_KEY = 'tqv.export.role.v1';
const COMPANY_KEY = 'tqv.export.company.v1';
const CLIENT_KEY = 'tqv.export.client.v1';
const APPROVER_KEY = 'tqv.export.approver.v1';
const RATE_KEY = 'tqv.export.rate.v1';
const CURRENCY_KEY = 'tqv.export.currency.v1';
// Only a hand-typed reference is remembered. A derived one (TS-2026-07) is a
// property of the exported month, not of the engagement, so persisting it would
// carry July's reference into August.
const REFERENCE_KEY = 'tqv.export.reference.v1';
// The engagement note has to be grammatical in the language it prints in, so
// each template language keeps its own text rather than one being reused.
const ENGAGEMENT_KEY = (locale: 'en' | 'cs') => `tqv.export.engagement.${locale}.v1`;

/**
 * Default document reference for a range — the year and month it starts in.
 * Only a suggestion: the reference identifies the document to the client, so it
 * is theirs to set, and it is remembered per device once edited.
 */
const defaultReference = (fromMs: number): string => {
  const d = new Date(fromMs);
  return `TS-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** "1125" / "1 125,50" → hourly rate number; empty or unparsable = no rate. */
const parseRate = (s: string): number | null => {
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const readStored = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};

/** Persist a field, or drop it when blank. No-ops when storage is unavailable. */
const writeStored = (key: string, value: string): void => {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Private mode — the export itself still works.
  }
};

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
  /** Optional cap (characters) on merged descriptions; null = no limit. */
  maxDescriptionLength: number | null;
  /** When true, cap each week's billable total at `weeklyHours` (overtime unbilled). */
  noOvertime: boolean;
  /** Weekly cap (hours) the overtime trim reduces the billed total to. */
  weeklyHours: number;
  /** Tag marking a time-off entry (its day is a holiday; the entry never exports). */
  timeOffTag: string;
  /** Linked billing codes (see lib/timesheet/mapping); empty = none. */
  codeMappings: CodeMapping[];
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
  maxDescriptionLength,
  noOvertime,
  weeklyHours,
  timeOffTag,
  codeMappings,
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
  // PDF only, and only when a description limit is set: a PDF is read by people,
  // not pasted into the client's system, so it defaults to the full text; the
  // technical formats (CSV/XLSX) always honour the limit.
  const [pdfDescs, setPdfDescs] = useState<'full' | 'short'>('full');
  const [name, setName] = useState(personName);
  const [role, setRole] = useState(() => readStored(ROLE_KEY));
  const [company, setCompany] = useState(() => readStored(COMPANY_KEY));
  const [client, setClient] = useState(() => readStored(CLIENT_KEY));
  const [approver, setApprover] = useState(() => readStored(APPROVER_KEY));
  // The reference tracks the chosen range (TS-2026-07) until the user types one
  // of their own — a PO or contract number, say — after which it is left alone
  // and remembered. Clearing the box hands it back to the range.
  const [reference, setReference] = useState(
    () => readStored(REFERENCE_KEY) || defaultReference(initial.fromMs)
  );
  const [refEdited, setRefEdited] = useState(() => readStored(REFERENCE_KEY) !== '');
  // Both languages' notes are held at once; the box shows the selected
  // template's, so switching language never overwrites the other text.
  const [engagements, setEngagements] = useState<Record<'en' | 'cs', string>>(() => ({
    en: readStored(ENGAGEMENT_KEY('en')),
    cs: readStored(ENGAGEMENT_KEY('cs')),
  }));
  const [rateStr, setRateStr] = useState(() => readStored(RATE_KEY));
  const [currency, setCurrency] = useState(() => readStored(CURRENCY_KEY));
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
    if (!refEdited) setReference(defaultReference(r.fromMs));
  };

  const editFrom = (v: string) => {
    setFromStr(v);
    setPreset('custom');
    setDone(null);
    const r = rangeFromInputs(v, toStr);
    if (!refEdited && r) setReference(defaultReference(r.fromMs));
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
        maxDescriptionLength:
          format === 'pdf' && pdfDescs === 'full' ? null : maxDescriptionLength,
        noOvertime,
        weeklyHours,
        timeOffTag,
        codeMappings,
        title,
        personName: name.trim(),
        role: role.trim(),
        company: company.trim(),
        client: client.trim(),
        approver: approver.trim(),
        reference: reference.trim() || defaultReference(range.fromMs),
        engagement: engagements[tplLocale].trim(),
        rate: parseRate(rateStr),
        currency: currency.trim().toUpperCase(),
      });
      // Remember the identity fields for the next export on this device. The
      // engagement notes are saved as they are typed (see the textarea), since
      // losing a paragraph to a failed export would be the expensive mistake.
      writeStored(ROLE_KEY, role.trim());
      writeStored(COMPANY_KEY, company.trim());
      writeStored(CLIENT_KEY, client.trim());
      writeStored(APPROVER_KEY, approver.trim());
      writeStored(RATE_KEY, rateStr.trim());
      writeStored(CURRENCY_KEY, currency.trim().toUpperCase());
      // A derived reference is dropped rather than stored, so next month's
      // export starts from that month again.
      writeStored(REFERENCE_KEY, refEdited ? reference.trim() : '');
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
  // Language the selected PDF template prints in — drives which engagement note
  // is shown and stored.
  const tplLocale =
    (format === 'pdf' ? PDF_TEMPLATES.find((t) => t.id === templateId)?.locale : undefined) ?? 'en';
  // Identity inputs (role / company) appear only when the chosen PDF template
  // actually prints them.
  const templateFields =
    format === 'pdf' ? PDF_TEMPLATES.find((t) => t.id === templateId)?.fields ?? [] : [];

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

        {format === 'pdf' && maxDescriptionLength != null && (
          <div className="field">
            <label htmlFor="exp-descs">Descriptions</label>
            <select
              id="exp-descs"
              value={pdfDescs}
              onChange={(e) => {
                setPdfDescs(e.target.value as 'full' | 'short');
                setDone(null);
              }}
            >
              <option value="full">Full text</option>
              <option value="short">Shortened to {maxDescriptionLength} characters (as on screen)</option>
            </select>
            <p className="hint">
              A PDF is read by people, not pasted into the client&apos;s system, so it shows the
              full descriptions by default even though a {maxDescriptionLength}-character limit is
              set. Pick <strong>Shortened</strong> to match the on-screen (and CSV/XLSX) text
              instead.
            </p>
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

        {templateFields.includes('role') && (
          <div className="field">
            <label htmlFor="exp-role">Role</label>
            <input
              id="exp-role"
              type="text"
              value={role}
              placeholder="e.g. your role on the project"
              onChange={(e) => {
                setRole(e.target.value);
                setDone(null);
              }}
            />
            <p className="hint">
              These details are remembered on this device only — they are never stored in the
              app.
            </p>
          </div>
        )}

        {templateFields.includes('company') && (
          <div className="field">
            <label htmlFor="exp-company">Company</label>
            <input
              id="exp-company"
              type="text"
              value={company}
              placeholder="Shown in the header and the day table"
              onChange={(e) => {
                setCompany(e.target.value);
                setDone(null);
              }}
            />
          </div>
        )}

        {templateFields.includes('client') && (
          <div className="field">
            <label htmlFor="exp-client">Client</label>
            <input
              id="exp-client"
              type="text"
              value={client}
              placeholder="Named on the cover; defaults to your company"
              onChange={(e) => {
                setClient(e.target.value);
                setDone(null);
              }}
            />
          </div>
        )}

        {templateFields.includes('reference') && (
          <div className="field">
            <label htmlFor="exp-reference">Reference</label>
            <input
              id="exp-reference"
              type="text"
              value={reference}
              placeholder={defaultReference(rangeFromInputs(fromStr, toStr)?.fromMs ?? nowMs)}
              onChange={(e) => {
                const v = e.target.value;
                setReference(v);
                // Emptying the box is how you go back to the month default.
                setRefEdited(v.trim() !== '');
                setDone(null);
              }}
            />
            <p className="hint">
              Printed on the cover, in every page footer and in the approval declaration.
              Follows the exported month until you type your own — a PO, contract or invoice
              number — which is then remembered for next time. Clear the box to hand it back
              to the month.
            </p>
          </div>
        )}

        {templateFields.includes('approver') && (
          <div className="field">
            <label htmlFor="exp-approver">Approver</label>
            <input
              id="exp-approver"
              type="text"
              value={approver}
              placeholder="e.g. Project Manager — left blank to fill by hand"
              onChange={(e) => {
                setApprover(e.target.value);
                setDone(null);
              }}
            />
          </div>
        )}

        {templateFields.includes('engagement') && (
          <div className="field">
            <label htmlFor="exp-engagement">
              Engagement note ({ENGAGEMENT_LABELS[tplLocale]})
            </label>
            <textarea
              id="exp-engagement"
              rows={4}
              value={engagements[tplLocale]}
              placeholder={ENGAGEMENT_PLACEHOLDERS[tplLocale]}
              onChange={(e) => {
                const v = e.target.value;
                setEngagements((prev) => ({ ...prev, [tplLocale]: v }));
                // Saved as typed: this is the one field long enough that losing
                // it to a failed export or a closed dialog would sting.
                writeStored(ENGAGEMENT_KEY(tplLocale), v.trim());
                setDone(null);
              }}
            />
            <p className="hint">
              Opens <strong>Basis of preparation</strong> on the last page, printed word for
              word — so write it in {ENGAGEMENT_LABELS[tplLocale]}, with the contract, order
              and end customer named however this engagement identifies them. Each language
              keeps its own text; switching template shows the other one. The standing
              wording after it (billing codes, rounding, the man-day basis, confidentiality)
              is added for you.
            </p>
          </div>
        )}

        {templateFields.includes('rate') && (
          <div className="exp-dates">
            <div className="field">
              <label htmlFor="exp-rate">Hourly rate (optional)</label>
              <input
                id="exp-rate"
                type="text"
                inputMode="decimal"
                value={rateStr}
                placeholder="Empty = no fees in the report"
                onChange={(e) => {
                  setRateStr(e.target.value);
                  setDone(null);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="exp-currency">Currency</label>
              <input
                id="exp-currency"
                type="text"
                maxLength={3}
                value={currency}
                placeholder="CZK"
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setDone(null);
                }}
              />
            </div>
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
