'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SelectedProject } from '@/components/SettingsPanel';
import type { TimesheetMode } from '@/components/SettingsPanel';
import type { TimeEntry } from '@/lib/calc';
import type { FetchedEntries } from '@/lib/source/types';
import { isAuthRequired, isRateLimit } from '@/lib/source/errors';
import { getConfig } from '@/lib/source/config';
import { loadAuth } from '@/lib/source/auth';
import {
  type ExportPreset,
  PRESET_LABELS,
  resolvePreset,
  clipRangeToStart,
  rangeFromInputs,
  toDateInput,
} from '@/lib/export/range';
import { buildExportDoc } from '@/lib/export/model';
import type { CodeMapping } from '@/lib/timesheet/mapping';
import {
  type ExportFormat,
  type SignRequest,
  FORMAT_LABELS,
  runExport,
} from '@/lib/export';
import { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID, LOCALE_LABELS } from '@/lib/export/pdf';
import SignatureBlockPreview from './SignatureBlockPreview';
import { HOURS_PER_MD } from '@/lib/export/pdf/money';
// Types and defaults only; the signing stage (pdf-lib, PKI.js, @signpdf) is
// imported dynamically once signing is switched on.
import {
  DEFAULT_SIGNATURE_APPEARANCE,
  isEmbeddableSignatureImage,
  SIGNATURE_IMAGE_ACCEPT,
  type SignatureAppearance,
  type SignatureLayout,
} from '@/lib/export/pdf/sign/types';
// Types only; tokenBridge has no implementation, so nothing heavy is bundled.
import type {
  BridgeReadiness,
  TokenBridge,
  TokenCertificate,
} from '@/lib/export/pdf/sign/tokenBridge';

// Identity fields some PDF templates print, remembered per workspace
// (see lib/exportFields).
import {
  engagementKey,
  MAX_SIGNATURE_IMAGE_CHARS,
  type ExportFieldValues,
} from '@/lib/exportFields';

/**
 * Default document reference: the year and month the range starts in. Once the
 * user types their own it is remembered with the workspace.
 */
const defaultReference = (fromMs: number): string => {
  const d = new Date(fromMs);
  return `TS-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/** "1125" / "1 125,50" → rate number; empty or unparsable = no rate. */
const parseRate = (s: string): number | null => {
  const n = parseFloat(s.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * One sentence on what is stopping the hardware bridge. Each state has a
 * different fix (install the extension, install the helper, insert the card).
 */
function describeReadiness(readiness: BridgeReadiness | null): React.ReactNode {
  if (!readiness || readiness.state === 'ready') return null;
  switch (readiness.state) {
    case 'unsupported':
      return readiness.reason;
    case 'extension-missing':
      return (
        <>
          The <a href={readiness.installUrl} target="_blank" rel="noreferrer">Sign Bridge
          extension</a> is not installed in this browser.
        </>
      );
    case 'helper-missing':
      return (
        <>
          The extension is installed but its <a href={readiness.installUrl} target="_blank" rel="noreferrer">
          helper app</a> is not. Both are needed.
        </>
      );
    case 'helper-outdated':
      return (
        <>
          The helper is version {readiness.have}; this app needs {readiness.need}.{' '}
          <a href={readiness.installUrl} target="_blank" rel="noreferrer">Update it</a>.
        </>
      );
    case 'not-paired':
      return 'Sign Bridge will ask you to approve this site the first time you connect.';
    case 'no-token':
      return readiness.reason;
  }
}

/**
 * One line naming a certificate in the picker. The CN alone is ambiguous: a
 * TWINS card holds two certificates for the same person, and the software key
 * store may hold more. So the line gives who, what kind, and where.
 */
function describeCertificate(c: TokenCertificate): string {
  const kind = c.qualified ? 'qualified' : c.forSignature ? 'signing' : 'authentication';
  const expires = new Date(c.notAfterMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  // Kind right after the name: a native <select> truncates, and the kind is
  // what distinguishes two certificates with the same CN.
  return `${c.subjectCN} (${kind}) — ${c.providerName}, to ${expires}`;
}

/**
 * The signature's /Reason, shown in a viewer's signature panel. Fixed: the
 * document has one reason to be signed.
 */
const SIGN_REASON: Record<'en' | 'cs', string> = {
  en: 'Approval of the timesheet',
  cs: 'Schválení výkazu práce',
};

// Presets in dropdown order. "custom" appears once a date is edited by hand.
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
  nowMs: number;
  /** Saturday-start of the week currently shown on the page (anchors "selected week"). */
  selectedWeekStart: number | null;
  maxBillableHours: number;
  billingTagPrefix: string;
  /** Rounding granularity in seconds (900 = 15 min default, 720 = 12 min). */
  roundingSeconds: number;
  /** Grid the Individual view's start times snap to, in seconds (see lib/timesheet/individual). */
  startWindowSeconds: number;
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
  /** When true, billing codes export without their parenthetical groups. */
  stripCodeParens: boolean;
  /** When true, the workspace bills by project instead of by billing code. */
  billByProject: boolean;
  /** Document title (project / group name). */
  title: string;
  /** Person the timesheet is for (resolved name, may be empty). */
  personName: string;
  /**
   * Entries already loaded (the week on screen) and the half-open range they
   * cover. An export range inside it reuses them instead of fetching again.
   */
  prefetched: { fromMs: number; toMs: number; entries: TimeEntry[] } | null;
  loadRange: (startISO: string, endISO: string, opts?: { force?: boolean }) => Promise<FetchedEntries>;
  /** Remembered identity fields of the workspace being exported. */
  fields: ExportFieldValues;
  /** Persist them back onto that workspace (see UseTrackSource.setExportFields). */
  onFieldsChange: (fields: ExportFieldValues) => void;
  /** Name of the workspace they belong to, for the hint; empty when none. */
  fieldsScope: string;
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
  startWindowSeconds,
  maxDescriptionLength,
  noOvertime,
  weeklyHours,
  timeOffTag,
  codeMappings,
  stripCodeParens,
  billByProject,
  title,
  personName,
  prefetched,
  loadRange,
  fields,
  onFieldsChange,
  fieldsScope,
  onClose,
}: ExportDialogProps) {
  const [preset, setPreset] = useState<ExportPreset>('current-month');
  // The workspace's first billable day; presets are clipped to it.
  const [startDate, setStartDate] = useState(fields.startDate);
  const initial = useMemo(
    () => clipRangeToStart(resolvePreset('current-month', nowMs, selectedWeekStart), fields.startDate),
    // Seed once on mount; preset changes update the inputs directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [fromStr, setFromStr] = useState(() => toDateInput(initial.fromMs));
  const [toStr, setToStr] = useState(() => toDateInput(initial.toMs - 1)); // inclusive last day
  const [format, setFormat] = useState<ExportFormat>('xlsx');
  const [templateId, setTemplateId] = useState<string>(DEFAULT_TEMPLATE_ID);
  // PDF only, when a description limit is set. PDFs default to full text;
  // CSV/XLSX always apply the limit.
  const [pdfDescs, setPdfDescs] = useState<'full' | 'short'>('full');
  const [name, setName] = useState(personName);
  // Seeded from the workspace's remembered fields and written back on export
  // (the engagement note and start date as they are typed). The role is kept
  // per language; the box shows the selected template's.
  const [roles, setRoles] = useState<Record<'en' | 'cs', string>>(() => ({
    en: fields.role,
    cs: fields.roleCs,
  }));
  const [company, setCompany] = useState(fields.company);
  const [client, setClient] = useState(fields.client);
  const [approver, setApprover] = useState(fields.approver);
  // The reference follows the range (TS-2026-07) until the user types one;
  // clearing the box makes it follow the range again.
  const [reference, setReference] = useState(fields.reference || defaultReference(initial.fromMs));
  const [refEdited, setRefEdited] = useState(fields.reference !== '');
  // Both languages' notes are held; the box shows the selected template's.
  const [engagements, setEngagements] = useState<Record<'en' | 'cs', string>>(() => ({
    en: fields.engagementEn,
    cs: fields.engagementCs,
  }));
  const [rateStr, setRateStr] = useState(fields.rate);
  // Stored as 'md' for a man-day rate; any other value is hourly.
  const [rateBasis, setRateBasis] = useState<'hourly' | 'md'>(
    fields.rateBasis === 'md' ? 'md' : 'hourly'
  );
  const [currency, setCurrency] = useState(fields.currency);
  // Digital signature (lib/export/pdf/sign). Off by default; offered only for
  // templates that reserve a signature area.
  const [signing, setSigning] = useState(false);
  // Whether the deployment has a TSA configured (TSA_URL); null until asked.
  // Not a user choice: when available, every signature is timestamped.
  const [canTimestamp, setCanTimestamp] = useState<boolean | null>(null);
  // Drop a remembered scan pdfmake cannot embed (e.g. a stored WebP).
  const rememberedImage = isEmbeddableSignatureImage(fields.signatureImage)
    ? fields.signatureImage
    : '';
  const [signatureImage, setSignatureImage] = useState(rememberedImage);
  const [signatureLayout, setSignatureLayout] = useState<SignatureLayout>(
    fields.signatureLayout === 'image-left' ? 'image-left' : 'image-above'
  );
  const [signatureNote, setSignatureNote] = useState<string | null>(
    fields.signatureImage && !rememberedImage
      ? 'The saved signature scan is not a PNG or JPEG, so it can’t be used. Choose a new file.'
      : null
  );
  // The signing bridge and certificate, discovered when signing is switched
  // on. The certificate is always the user's choice: an I.CA TWINS card holds
  // a qualified signing certificate and an authentication one, and signing
  // with the latter gives a valid signature that is not qualified.
  const [bridgeChoices, setBridgeChoices] = useState<{ id: string; label: string }[] | null>(null);
  const [bridgeId, setBridgeId] = useState('');
  const [certificates, setCertificates] = useState<TokenCertificate[] | null>(null);
  const [certificateId, setCertificateId] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Why the preferred bridge is unavailable. Shown as a hint, not an error,
  // since signing is optional.
  const [readiness, setReadiness] = useState<BridgeReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // The chosen template decides which identity inputs appear, their
  // placeholders, the notes' language and whether signing is offered. No
  // template is referenced by name (see lib/export/pdf/types).
  const template = format === 'pdf' ? PDF_TEMPLATES.find((t) => t.id === templateId) : undefined;
  const tplLocale = template?.locale ?? 'en';
  const templateFields = template?.fields ?? [];
  const signatureWidget = template?.signatureWidget;

  // Built once per dialog: each bridge holds live state (the extension port and
  // its listed certificates, or the throwaway key shown in the preview).
  const bridgesRef = useRef<TokenBridge[] | null>(null);
  const loadBridges = async (): Promise<TokenBridge[]> => {
    if (!bridgesRef.current) {
      const { availableBridges } = await import('@/lib/export/pdf/sign/bridge');
      bridgesRef.current = availableBridges({
        signBridge: { onPairingCode: setPairingCode },
      });
    }
    return bridgesRef.current;
  };

  const selectedBridge = bridgesRef.current?.find((b) => b.id === bridgeId) ?? null;
  const certificate = certificates?.find((c) => c.id === certificateId) ?? null;

  /**
   * The signature block as previewed and signed. The date is set at signing
   * time so the printed date matches the signature's /M; the preview uses
   * `nowMs`.
   */
  const appearance: SignatureAppearance = useMemo(
    () => ({
      ...DEFAULT_SIGNATURE_APPEARANCE,
      image: signatureImage || null,
      signerName: name.trim() || personName,
      certificateCN: certificate?.subjectCN ?? '',
      layout: signatureLayout,
      locale: tplLocale,
    }),
    [signatureImage, name, personName, certificate, signatureLayout, tplLocale]
  );

  // Switching signing on loads the signing stage and discovers bridges.
  // Discovery connects nothing, so it never triggers a pairing or PIN prompt.
  useEffect(() => {
    if (!signing || !signatureWidget) return;
    let cancelled = false;
    (async () => {
      const bridges = await loadBridges();
      const offered: { id: string; label: string }[] = [];
      let firstProblem: BridgeReadiness | null = null;
      for (const bridge of bridges) {
        if (await bridge.isAvailable()) {
          offered.push({ id: bridge.id, label: bridge.label });
          continue;
        }
        // Report the first (preferred) bridge's problem; the throwaway key at
        // the end is always available.
        if (!firstProblem && bridge.readiness) firstProblem = await bridge.readiness();
      }
      if (cancelled) return;
      setReadiness(firstProblem);
      setBridgeChoices(offered);
      setBridgeId((current) => (offered.some((b) => b.id === current) ? current : offered[0]?.id ?? ''));
    })().catch((e: unknown) => {
      if (cancelled) return;
      setBridgeChoices([]);
      setError(e instanceof Error ? e.message : 'Could not look for a signing device.');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signing, signatureWidget]);

  // Asked once signing is switched on, not on mount, so a plain export makes
  // no /api/config request.
  useEffect(() => {
    if (!signing || canTimestamp !== null) return;
    let cancelled = false;
    getConfig().then(
      (config) => {
        if (!cancelled) setCanTimestamp(config.timestamp.enabled);
      },
      () => {
        // No config: sign without a timestamp (B-B).
        if (!cancelled) setCanTimestamp(false);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [signing, canTimestamp]);

  // A non-interactive bridge (the throwaway key) is listed immediately so the
  // preview can show its CN. An interactive one waits for the Connect button.
  useEffect(() => {
    setCertificates(null);
    setCertificateId('');
    setPairingCode(null);
    const bridge = bridgesRef.current?.find((b) => b.id === bridgeId);
    if (!bridge || bridge.interactive) return;
    let cancelled = false;
    bridge.listCertificates().then(
      (list) => {
        if (cancelled) return;
        setCertificates(list);
        setCertificateId(list[0]?.id ?? '');
      },
      (e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not prepare a signing key.');
      }
    );
    return () => {
      cancelled = true;
    };
  }, [bridgeId]);

  /** Pair, unlock and list certificates; the only step allowed to prompt. */
  const connectBridge = async () => {
    const bridge = bridgesRef.current?.find((b) => b.id === bridgeId);
    if (!bridge) return;
    setConnecting(true);
    setError(null);
    setDone(null);
    try {
      const all = await bridge.listCertificates();
      // Only certificates with a private key. A card also reports its issuer's
      // CA certificates (about thirty on an I.CA card), which cannot sign.
      const list = all.filter((c) => c.hasKey);
      setCertificates(list);
      // Preselect a qualified certificate with non-repudiation key usage, so
      // the TWINS authentication certificate is not picked by default.
      const preferred =
        list.find((c) => c.qualified && c.forSignature) ??
        list.find((c) => c.forSignature) ??
        list[0];
      setCertificateId(preferred?.id ?? '');
      if (!list.length) {
        setError(
          all.length
            ? `The device has ${all.length} certificate${all.length === 1 ? '' : 's'} but no ` +
                'private key for any of them. Usually no certificate has been issued to the card yet.'
            : 'The device has no usable certificate. The card may have none issued yet, ' +
                'or its certificates may have expired.'
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the signing device.');
    } finally {
      setPairingCode(null);
      setConnecting(false);
    }
  };

  /** Read a picked scan into a data: URL. */
  const pickSignatureImage = async (file: File | null) => {
    if (!file) return;
    setDone(null);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    // Checked by the file's bytes, not its claimed type: pdfmake (via PDFKit)
    // embeds only PNG and JPEG.
    if (!isEmbeddableSignatureImage(dataUrl)) {
      setError(
        'The signature must be a PNG or JPEG. Convert WebP or HEIC files first.'
      );
      return;
    }
    setError(null);
    setSignatureImage(dataUrl);
    setSignatureNote(
      dataUrl.length > MAX_SIGNATURE_IMAGE_CHARS
        ? 'This scan is too large to save, so it will be used for this export only. ' +
            'A cropped PNG under about 190 kB is saved.'
        : null
    );
  };

  const applyPreset = (p: ExportPreset, start = startDate) => {
    setPreset(p);
    setDone(null);
    if (p === 'custom') return;
    const r = clipRangeToStart(resolvePreset(p, nowMs, selectedWeekStart), start);
    setFromStr(toDateInput(r.fromMs));
    setToStr(toDateInput(r.toMs - 1));
    if (!refEdited) setReference(defaultReference(r.fromMs));
  };

  const editStartDate = (v: string) => {
    setStartDate(v);
    setDone(null);
    // Saved as typed rather than on export: it is often set before any export.
    onFieldsChange({ ...fields, startDate: v });
    // Re-apply the preset so the clip shows at once; a custom range is kept.
    if (preset !== 'custom') applyPreset(preset, v);
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
      setError('Pick a valid range: the “to” date must be on or after the “from” date.');
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      // Reuse the on-screen week's entries when they cover the range; otherwise
      // fetch it (through the server cache when one is configured).
      const covered =
        prefetched != null &&
        range.fromMs >= prefetched.fromMs &&
        range.toMs <= prefetched.toMs;
      const entries = covered
        ? (prefetched as NonNullable<typeof prefetched>).entries
        : (await loadRange(new Date(range.fromMs).toISOString(), new Date(range.toMs).toISOString()))
            .entries;
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
        startWindowSeconds,
        maxDescriptionLength:
          format === 'pdf' && pdfDescs === 'full' ? null : maxDescriptionLength,
        noOvertime,
        weeklyHours,
        timeOffTag,
        codeMappings,
        stripCodeParens,
        billByProject,
        title,
        personName: name.trim(),
        // The template's language, falling back to the other when empty.
        role: roles[tplLocale].trim() || roles[tplLocale === 'cs' ? 'en' : 'cs'].trim(),
        company: company.trim(),
        client: client.trim(),
        approver: approver.trim(),
        reference: reference.trim() || defaultReference(range.fromMs),
        engagement: engagements[tplLocale].trim(),
        rate: parseRate(rateStr),
        rateBasis,
        currency: currency.trim().toUpperCase(),
      });
      // Remember the fields for this workspace's next export.
      onFieldsChange({
        ...fields,
        role: roles.en.trim(),
        roleCs: roles.cs.trim(),
        startDate,
        company: company.trim(),
        client: client.trim(),
        approver: approver.trim(),
        rate: rateStr.trim(),
        rateBasis,
        currency: currency.trim().toUpperCase(),
        // Store only a hand-typed reference; a derived one follows the month.
        reference: refEdited ? reference.trim() : '',
        engagementEn: engagements.en.trim(),
        engagementCs: engagements.cs.trim(),
        // A scan too large to store is used once; the previous one is kept.
        signatureImage:
          signatureImage.length <= MAX_SIGNATURE_IMAGE_CHARS
            ? signatureImage
            : fields.signatureImage,
        signatureLayout,
      });

      // The signer reports the level through a callback because the timestamp
      // can fail after the card has signed; the file still downloads at B-B
      // and the message says so (see lib/export/pdf/sign/signer.ts).
      // An object rather than two `let`s: TypeScript would narrow a `let` to its
      // initial value, since only the callback assigns it.
      const outcome: { level: 'B-B' | 'B-T'; timestampError: Error | null } = {
        level: 'B-B',
        timestampError: null,
      };
      let signRequest: SignRequest | null = null;
      if (format === 'pdf' && signing && signatureWidget) {
        if (!selectedBridge || !certificate) {
          setError('Choose the certificate to sign with before exporting.');
          return;
        }
        signRequest = {
          bridge: selectedBridge,
          certificate,
          appearance: {
            ...appearance,
            certificateCN: certificate.subjectCN,
            // One timestamp for the printed date and the /M entry.
            signedAtMs: Date.now(),
          },
          reason: SIGN_REASON[tplLocale],
          // The timestamp route is behind the password gate; no token when
          // the deployment has no gate.
          timestamp: canTimestamp ? { appAuth: loadAuth()?.token ?? null } : false,
          onLevel: (level, timestampError) => {
            outcome.level = level;
            outcome.timestampError = timestampError;
          },
        };
      }

      const ok = await runExport(doc, format, templateId, signRequest);
      if (!ok) {
        setError('No entries in this range.');
        return;
      }
      if (!signRequest) {
        setDone(`Exported as ${FORMAT_LABELS[format]}.`);
      } else if (outcome.level === 'B-T') {
        setDone(
          `Exported as ${FORMAT_LABELS[format]}, digitally signed and timestamped ` +
            '(PAdES-B-T). The signature stays verifiable after the certificate expires.'
        );
      } else if (outcome.timestampError) {
        // Signed and downloaded, but without the timestamp; say so.
        setDone(
          `Exported as ${FORMAT_LABELS[format]}, digitally signed without a timestamp ` +
            `(PAdES-B-B), so the signature stops verifying when the certificate expires. ` +
            `Timestamp error: ${outcome.timestampError.message}`
        );
      } else {
        setDone(`Exported as ${FORMAT_LABELS[format]}, digitally signed (PAdES-B-B).`);
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'TokenBridgeUnavailableError') {
        setError(e.message);
      } else if (isAuthRequired(e)) {
        setError('Session expired. Go back to the timesheet, sign in again, then retry.');
      } else if (isRateLimit(e)) {
        setError('Toggl rate limit reached. Wait a moment, then try again.');
      } else {
        // Anything else can come from fetching, rendering or signing; show
        // the error's own message.
        console.error('Export failed', e);
        const detail = e instanceof Error ? e.message : String(e);
        setError(
          detail
            ? `The export failed: ${detail}`
            : 'The export failed with no message. See the browser console for details.'
        );
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
          Exports the <strong>{viewLabel}</strong> view as shown, with its rounding
          and grouping, not the raw entries.
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

        {!rangeValid && (
          <p className="err-msg">
            The range is empty: the “to” date is before the “from” date. A preset that
            ends before the workspace start date below has nothing to export.
          </p>
        )}

        <div className="field">
          <label htmlFor="exp-start-date">Workspace start date (optional)</label>
          <input
            id="exp-start-date"
            type="date"
            value={startDate}
            onChange={(e) => editStartDate(e.target.value)}
          />
          <p className="hint">
            First billable day of this engagement. Week and month presets start no earlier
            than this, so a workspace that began on Aug 16 exports Aug 16–31 as its first
            month. Dates you edit by hand are not changed. Saved with{' '}
            {fieldsScope ? <strong>{fieldsScope}</strong> : 'this device'} as you type.
          </p>
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
              PDFs show full descriptions by default, ignoring the {maxDescriptionLength}-character
              limit. Pick Shortened to match the on-screen and CSV/XLSX text.
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
            <p className="hint">{template?.description}</p>
          </div>
        )}

        {templateFields.includes('role') && (
          <div className="field">
            <label htmlFor="exp-role">Role ({LOCALE_LABELS[tplLocale]})</label>
            <input
              id="exp-role"
              type="text"
              value={roles[tplLocale]}
              placeholder={
                roles[tplLocale === 'cs' ? 'en' : 'cs'].trim()
                  ? `Leave empty to use “${roles[tplLocale === 'cs' ? 'en' : 'cs'].trim()}”`
                  : 'Your role on the project'
              }
              onChange={(e) => {
                const v = e.target.value;
                setRoles((prev) => ({ ...prev, [tplLocale]: v }));
                setDone(null);
              }}
            />
            <p className="hint">
              Kept separately per template language (Integration architect / Integrační
              architekt). If this language is empty, the other one is printed.{' '}
              {fieldsScope ? (
                <>
                  These details are saved with <strong>{fieldsScope}</strong>; each workspace
                  has its own.
                </>
              ) : (
                <>These details are saved on this device.</>
              )}{' '}
              Settings sync, when on, carries them to your other devices.
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
                // Emptying the box restores the month default.
                setRefEdited(v.trim() !== '');
                setDone(null);
              }}
            />
            <p className="hint">
              Printed on the cover, in each page footer and in the approval declaration.
              Defaults to the exported month. Type your own (a PO, contract or invoice
              number) to keep it for next time; clear the box to return to the default.
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
              placeholder="e.g. Project Manager; leave blank to fill in by hand"
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
              Engagement note ({LOCALE_LABELS[tplLocale]})
            </label>
            <textarea
              id="exp-engagement"
              rows={4}
              value={engagements[tplLocale]}
              placeholder={template?.fieldHints?.engagement}
              onChange={(e) => {
                const v = e.target.value;
                setEngagements((prev) => ({ ...prev, [tplLocale]: v }));
                // Saved as typed so a long note survives a failed export or a
                // closed dialog.
                onFieldsChange({ ...fields, [engagementKey(tplLocale)]: v.trim() });
                setDone(null);
              }}
            />
            <p className="hint">
              Printed verbatim in the template&apos;s basis-of-preparation section, so write it
              in {LOCALE_LABELS[tplLocale]}. Name the contract, order and end customer. Each
              language has its own note. The template adds the standard wording (billing
              codes, rounding, man-day basis, confidentiality).
            </p>
          </div>
        )}

        {templateFields.includes('rate') && (
          <>
            <div className="field">
              <label htmlFor="exp-rate-basis">Rate quoted per</label>
              <select
                id="exp-rate-basis"
                value={rateBasis}
                onChange={(e) => {
                  setRateBasis(e.target.value as 'hourly' | 'md');
                  setDone(null);
                }}
              >
                <option value="hourly">Hour (hourly rate)</option>
                <option value="md">Man-day (MD rate, {HOURS_PER_MD} h = 1 MD)</option>
              </select>
              <p className="hint">
                The unit your contract quotes the rate in. Fee tables and wording use it
                throughout: an MD rate is shown as man-days × MD rate, not converted to
                hourly.
              </p>
            </div>
            <div className="exp-dates">
              <div className="field">
                <label htmlFor="exp-rate">
                  {rateBasis === 'md' ? 'MD rate (optional)' : 'Hourly rate (optional)'}
                </label>
                <input
                  id="exp-rate"
                  type="text"
                  inputMode="decimal"
                  value={rateStr}
                  placeholder="Leave empty for no fees"
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
          </>
        )}

        {signatureWidget && (
          <div className="field">
            <label htmlFor="exp-signing">Digital signature</label>
            <select
              id="exp-signing"
              value={signing ? 'on' : 'off'}
              onChange={(e) => {
                setSigning(e.target.value === 'on');
                setDone(null);
              }}
            >
              <option value="off">Leave the signature box empty</option>
              <option value="on">Sign the PDF</option>
            </select>
            <p className="hint">
              Turns the Prepared by box on the sign-off page into a signature field. The
              client&apos;s box stays blank for them. The certificate makes the signature;
              the handwritten image is only visual.
            </p>
          </div>
        )}

        {signatureWidget && signing && (
          <>
            <div className="field">
              <label htmlFor="exp-sign-bridge">Sign with</label>
              <select
                id="exp-sign-bridge"
                value={bridgeId}
                disabled={!bridgeChoices?.length}
                onChange={(e) => {
                  setBridgeId(e.target.value);
                  setDone(null);
                }}
              >
                {bridgeChoices === null && <option value="">Looking for a signing device…</option>}
                {bridgeChoices?.length === 0 && (
                  <option value="">Nothing on this device can sign</option>
                )}
                {bridgeChoices?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
              <p className="hint">
                The private key stays on the token. Sign Bridge, a browser extension with a
                helper app, passes the signing request to it. {describeReadiness(readiness)}
              </p>
            </div>

            <div className="field">
              <label htmlFor="exp-sign-cert">Certificate</label>
              {certificates === null ? (
                <div className="sig-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={!bridgeId || connecting}
                    onClick={() => void connectBridge()}
                  >
                    {connecting ? 'Connecting…' : 'Connect and list certificates'}
                  </button>
                </div>
              ) : (
                <select
                  id="exp-sign-cert"
                  value={certificateId}
                  disabled={!certificates.length}
                  onChange={(e) => {
                    setCertificateId(e.target.value);
                    setDone(null);
                  }}
                >
                  {!certificates.length && <option value="">No certificate to sign with</option>}
                  {certificates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {describeCertificate(c)}
                    </option>
                  ))}
                </select>
              )}
              {pairingCode && (
                <p className="hint">
                  Approve the window that just opened <strong>only</strong> if it shows the
                  code <strong>{pairingCode}</strong>. A matching code confirms the request
                  came from this page.
                </p>
              )}
              {certificate && !certificate.qualified && (
                <p className="hint">
                  This is not a qualified certificate on a qualified device. The signature
                  will be valid but <strong>not</strong> a qualified electronic signature
                  (QES). Fine for testing, not for real sign-off.
                </p>
              )}
              {certificate && !certificate.forSignature && (
                <p className="hint">
                  This certificate&apos;s key usage lacks non-repudiation, so it is for
                  authentication, not signing. On a TWINS card, pick the other entry.
                </p>
              )}
              {selectedBridge?.interactive && !pairingCode && (
                <p className="hint">
                  Connecting asks {selectedBridge.label.includes('Sign Bridge') ? 'Sign Bridge' : 'the helper'}{' '}
                  to approve this site (once). Signing then asks for the token PIN in a
                  separate window; the PIN is never entered on this page.
                </p>
              )}
            </div>

            <div className="field">
              <label htmlFor="exp-signature-image">Handwritten signature</label>
              <div className="sig-row">
                <input
                  id="exp-signature-image"
                  type="file"
                  accept={SIGNATURE_IMAGE_ACCEPT}
                  onChange={(e) => {
                    void pickSignatureImage(e.target.files?.[0] ?? null);
                    // Allow picking the same file again.
                    e.target.value = '';
                  }}
                />
                {signatureImage && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setSignatureImage('');
                      setSignatureNote(null);
                    }}
                  >
                    Remove
                  </button>
                )}
              </div>
              {signatureImage && (
                // A file input can't show a remembered scan (it says "No file
                // chosen"), so say it in words.
                <p className="hint sig-in-use">
                  Using the signature scan shown in the preview. Choose a file to replace it,
                  or Remove to clear it.
                </p>
              )}
              <p className="hint">
                A PNG or JPEG scan on a transparent or white background, placed in the
                signature block. Saved with{' '}
                {fieldsScope ? <strong>{fieldsScope}</strong> : 'this device'}; with settings
                sync on, it is stored on the server and synced to your other devices like the
                other export details.
              </p>
            </div>

            <div className="field">
              <label htmlFor="exp-signature-layout">Signature block layout</label>
              <select
                id="exp-signature-layout"
                value={signatureLayout}
                onChange={(e) => {
                  setSignatureLayout(e.target.value as SignatureLayout);
                  setDone(null);
                }}
              >
                <option value="image-above">Signature above the details</option>
                <option value="image-left">Signature beside the details</option>
              </select>
            </div>

            <div className="field">
              <label>Preview</label>
              <div className="sig-preview-frame">
                <SignatureBlockPreview
                  rect={signatureWidget.rect}
                  appearance={{ ...appearance, signedAtMs: nowMs }}
                />
              </div>
              <p className="hint">
                Printed size {Math.round(signatureWidget.rect.width)}
                &nbsp;&times;&nbsp;{Math.round(signatureWidget.rect.height)}&nbsp;pt, filling the
                dashed box on the last page. {signatureNote}
              </p>
            </div>
          </>
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
