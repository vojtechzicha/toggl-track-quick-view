'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { SelectedProject } from '@/components/SettingsPanel';
import type { TimesheetMode } from '@/components/SettingsPanel';
import type { TimeEntry } from '@/lib/calc';
import type { FetchedEntries } from '@/lib/source/types';
import { isAuthRequired, isRateLimit } from '@/lib/source/errors';
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
import { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID } from '@/lib/export/pdf';
import SignatureBlockPreview from './SignatureBlockPreview';
import { ENGAGEMENT_PLACEHOLDERS, ENGAGEMENT_LABELS } from '@/lib/export/pdf/report';
import { HOURS_PER_MD } from '@/lib/export/pdf/money';
// Types and defaults only — the signing stage itself (pdf-lib, PKI.js,
// @signpdf) is dynamically imported, and only once the user turns signing on.
import {
  DEFAULT_SIGNATURE_APPEARANCE,
  isEmbeddableSignatureImage,
  SIGNATURE_IMAGE_ACCEPT,
  type SignatureAppearance,
  type SignatureLayout,
} from '@/lib/export/pdf/sign/types';
// The bridge contract, types only — ./tokenBridge carries no implementation and
// so drags neither the signing stack nor PKI.js into this bundle.
import type {
  BridgeReadiness,
  TokenBridge,
  TokenCertificate,
} from '@/lib/export/pdf/sign/tokenBridge';

// Identity fields some PDF templates print (role / company / client / approver /
// rate). Their values are user-entered and handed in by the page: they are
// remembered with the workspace being billed (see lib/exportFields), and carried
// to other devices by settings sync when the deployment has one. The app itself
// ships no company names or rates.
import {
  engagementKey,
  MAX_SIGNATURE_IMAGE_CHARS,
  type ExportFieldValues,
} from '@/lib/exportFields';

/**
 * Default document reference for a range — the year and month it starts in.
 * Only a suggestion: the reference identifies the document to the client, so it
 * is theirs to set, and it is remembered per device once edited.
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
 * Recorded as the signature dictionary's /Reason, which is what a viewer's
 * signature panel shows. Fixed rather than a field: this document has exactly
 * one reason to be signed, and an empty or improvised one reads worse than none.
 */
/**
 * One sentence for whatever is stopping the hardware bridge.
 *
 * Each state has a different fix, which is the whole reason the bridge reports
 * a state rather than a boolean: "install the extension", "install the helper"
 * and "put the card in" are not interchangeable, and a single "unavailable"
 * sends people to the wrong one.
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
          The extension is here but its <a href={readiness.installUrl} target="_blank" rel="noreferrer">
          helper app</a> is not — both halves are needed.
        </>
      );
    case 'helper-outdated':
      return (
        <>
          The helper is version {readiness.have} and this build needs {readiness.need} —{' '}
          <a href={readiness.installUrl} target="_blank" rel="noreferrer">update it</a>.
        </>
      );
    case 'not-paired':
      return 'Sign Bridge will ask you to approve this site the first time you connect.';
    case 'no-token':
      return readiness.reason;
  }
}

/**
 * One line naming a certificate in the picker.
 *
 * The CN alone is not enough to choose by: a TWINS card carries two
 * certificates issued to the same person, differing only in what they are for,
 * and a machine with a token plugged in also has whatever sits in its software
 * key store. So the line says who, where, and whether it is the qualified one.
 */
function describeCertificate(c: TokenCertificate): string {
  const kind = c.qualified ? 'qualified' : c.forSignature ? 'signing' : 'authentication';
  const expires = new Date(c.notAfterMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  // Kind before provider, and right after the name: a native <select> truncates,
  // and on a card holding two certificates for the same person the CN is
  // identical — what tells them apart has to appear at the first difference.
  return `${c.subjectCN} (${kind}) — ${c.providerName}, to ${expires}`;
}

const SIGN_REASON: Record<'en' | 'cs', string> = {
  en: 'Approval of the timesheet',
  cs: 'Schválení výkazu práce',
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
  /** Grid the Individual view's start times anchor to, in seconds (see lib/calc). */
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
  // The workspace's first billable day; every preset is clipped to it, so a
  // mid-month engagement start never exports a document claiming the full month.
  const [startDate, setStartDate] = useState(fields.startDate);
  const initial = useMemo(
    () => clipRangeToStart(resolvePreset('current-month', nowMs, selectedWeekStart), fields.startDate),
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
  // Seeded once from the workspace's remembered fields; written back on export
  // (and, for the engagement note and start date, as they are typed).
  // Like the engagement note, the role is per-language ("Integration
  // architect" / "Integrační architekt") — the box shows the selected
  // template's, so switching language never overwrites the other text.
  const [roles, setRoles] = useState<Record<'en' | 'cs', string>>(() => ({
    en: fields.role,
    cs: fields.roleCs,
  }));
  const [company, setCompany] = useState(fields.company);
  const [client, setClient] = useState(fields.client);
  const [approver, setApprover] = useState(fields.approver);
  // The reference tracks the chosen range (TS-2026-07) until the user types one
  // of their own — a PO or contract number, say — after which it is left alone
  // and remembered. Clearing the box hands it back to the range.
  const [reference, setReference] = useState(fields.reference || defaultReference(initial.fromMs));
  const [refEdited, setRefEdited] = useState(fields.reference !== '');
  // Both languages' notes are held at once; the box shows the selected
  // template's, so switching language never overwrites the other text.
  const [engagements, setEngagements] = useState<Record<'en' | 'cs', string>>(() => ({
    en: fields.engagementEn,
    cs: fields.engagementCs,
  }));
  const [rateStr, setRateStr] = useState(fields.rate);
  // What the rate is quoted per. Stored as 'md' when the contract quotes a
  // man-day rate; every other stored value (the pre-basis '' included) is hourly.
  const [rateBasis, setRateBasis] = useState<'hourly' | 'md'>(
    fields.rateBasis === 'md' ? 'md' : 'hourly'
  );
  const [currency, setCurrency] = useState(fields.currency);
  // Digital signature (see lib/export/pdf/sign). Off by default and offered
  // only by templates that reserve an area for the widget: an export nobody
  // asked to sign has to come out exactly as it always did.
  const [signing, setSigning] = useState(false);
  // A remembered scan is only usable if pdfmake can embed it. One stored by an
  // earlier build (the picker used to accept WebP) is dropped rather than
  // carried into an export that would fail on it.
  const rememberedImage = isEmbeddableSignatureImage(fields.signatureImage)
    ? fields.signatureImage
    : '';
  const [signatureImage, setSignatureImage] = useState(rememberedImage);
  const [signatureLayout, setSignatureLayout] = useState<SignatureLayout>(
    fields.signatureLayout === 'image-left' ? 'image-left' : 'image-above'
  );
  const [signatureNote, setSignatureNote] = useState<string | null>(
    fields.signatureImage && !rememberedImage
      ? 'The remembered signature scan is not a PNG or a JPEG and cannot be embedded — pick the file again.'
      : null
  );
  // Where the signature comes from, and which certificate on it. Discovered
  // when signing is switched on; the certificate is chosen, never assumed —
  // I.CA's TWINS card carries a qualified signing certificate AND a commercial
  // authentication one, and picking the second produces a file that verifies
  // and is not a qualified signature.
  const [bridgeChoices, setBridgeChoices] = useState<{ id: string; label: string }[] | null>(null);
  const [bridgeId, setBridgeId] = useState('');
  const [certificates, setCertificates] = useState<TokenCertificate[] | null>(null);
  const [certificateId, setCertificateId] = useState('');
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // What is stopping the preferred bridge, when nothing is offered. Drives one
  // sentence and one link rather than an error: signing is optional, so a
  // missing helper is an explanation and never an interruption.
  const [readiness, setReadiness] = useState<BridgeReadiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Language the selected PDF template prints in — drives which engagement note
  // is shown and stored.
  const tplLocale =
    (format === 'pdf' ? PDF_TEMPLATES.find((t) => t.id === templateId)?.locale : undefined) ?? 'en';
  // Identity inputs (role / company) appear only when the chosen PDF template
  // actually prints them.
  const templateFields =
    format === 'pdf' ? PDF_TEMPLATES.find((t) => t.id === templateId)?.fields ?? [] : [];
  // Only a template that reserves a signature area can carry a widget; for the
  // rest the signing section is not offered at all.
  const signatureWidget =
    format === 'pdf' ? PDF_TEMPLATES.find((t) => t.id === templateId)?.signatureWidget : undefined;

  // The bridge objects themselves, built once per dialog rather than per
  // render: each one holds live state — the extension port and the certificates
  // it listed, or the throwaway key whose CN is already in the preview — and
  // rebuilding it would silently throw that away mid-flow.
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
   * The signature block's design, as previewed and as signed. The date is
   * filled in at the moment of signing so the printed date and the signature
   * dictionary's /M agree; the preview uses the page's clock instead.
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

  // Switching signing on is what pulls the signing stage into the page, and
  // what asks the machine what it can sign with. Nothing is connected here:
  // discovery must not put a pairing window or a PIN prompt in front of anyone.
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
        // Why the PREFERRED bridge is missing, not the last one: the throwaway
        // key is always available, so the last answer is never interesting.
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

  // A bridge that lists without asking anything is listed straight away — the
  // throwaway key, whose CN the preview then shows. An interactive one waits
  // for the button below.
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

  /** Pair, unlock and list — the step that is allowed to prompt. */
  const connectBridge = async () => {
    const bridge = bridgesRef.current?.find((b) => b.id === bridgeId);
    if (!bridge) return;
    setConnecting(true);
    setError(null);
    setDone(null);
    try {
      const all = await bridge.listCertificates();
      // Only what this device can actually sign with. A card reports its
      // issuer's CA certificates alongside its own — around thirty of them on
      // an I.CA card — and every one is a certificate with no private key here.
      // Offering them is offering a PIN prompt that ends in "no private key",
      // so they are counted and dropped rather than listed.
      const list = all.filter((c) => c.hasKey);
      setCertificates(list);
      // Preselect what the document actually needs: a qualified certificate
      // whose key usage allows non-repudiation. The alternative — first in the
      // list — is how the authentication half of a TWINS card ends up signing
      // an acceptance sheet.
      const preferred =
        list.find((c) => c.qualified && c.forSignature) ??
        list.find((c) => c.forSignature) ??
        list[0];
      setCertificateId(preferred?.id ?? '');
      if (!list.length) {
        setError(
          all.length
            ? `That device carries ${all.length} certificate${all.length === 1 ? '' : 's'} and the ` +
                'private key of none of them — which is what a card looks like before its own ' +
                'certificate has been issued onto it.'
            : 'That device holds no usable certificate. A card with no certificate on it yet, ' +
                'or one whose certificates have expired, both look like this.'
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reach the signing device.');
    } finally {
      setPairingCode(null);
      setConnecting(false);
    }
  };

  /** Read a picked scan into a data: URL — it never leaves the browser. */
  const pickSignatureImage = async (file: File | null) => {
    if (!file) return;
    setDone(null);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    // Judged by the file's own bytes, not by the type it claims: PDFKit — which
    // is what pdfmake embeds images through — reads PNG and JPEG and nothing
    // else, and a browser will display a WebP quite happily right up to the
    // point where the export cannot be produced.
    if (!isEmbeddableSignatureImage(dataUrl)) {
      setError(
        'The signature has to be a PNG or a JPEG — those are the formats a PDF can carry. ' +
          'A WebP or HEIC will need converting first.'
      );
      return;
    }
    setError(null);
    setSignatureImage(dataUrl);
    setSignatureNote(
      dataUrl.length > MAX_SIGNATURE_IMAGE_CHARS
        ? 'This scan is too large to remember with the workspace — it will be used for ' +
            'this export only. A trimmed PNG under ~190 kB is remembered.'
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
    // Saved as typed (not on export): this is set up once when the workspace is
    // created, quite possibly without exporting anything yet, and every later
    // month export leans on it.
    onFieldsChange({ ...fields, startDate: v });
    // Re-resolve the current preset so the dates show the clip immediately; a
    // hand-edited custom range stays the user's own.
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
        title,
        personName: name.trim(),
        // The template's own language, or the other one when it is empty — a
        // role that reads the same in both only has to be typed once.
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
      // Remember the identity fields for the next export of this workspace. The
      // engagement notes are saved as they are typed (see the textarea), since
      // losing a paragraph to a failed export would be the expensive mistake.
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
        // A derived reference is dropped rather than stored, so next month's
        // export starts from that month again.
        reference: refEdited ? reference.trim() : '',
        engagementEn: engagements.en.trim(),
        engagementCs: engagements.cs.trim(),
        // A scan too large to sync is used for this export and not stored —
        // whatever was remembered before stays remembered.
        signatureImage:
          signatureImage.length <= MAX_SIGNATURE_IMAGE_CHARS
            ? signatureImage
            : fields.signatureImage,
        signatureLayout,
      });

      // Signing is the last thing that happens and the only optional one: with
      // it off, `runExport` downloads exactly the blob the template rendered.
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
            // One clock for the printed date and the /M entry.
            signedAtMs: Date.now(),
          },
          reason: SIGN_REASON[tplLocale],
        };
      }

      const ok = await runExport(doc, format, templateId, signRequest);
      if (!ok) {
        setError('No entries in this range — nothing to export.');
        return;
      }
      setDone(
        signRequest
          ? `Exported as ${FORMAT_LABELS[format]}, digitally signed.`
          : `Exported as ${FORMAT_LABELS[format]}.`
      );
    } catch (e) {
      if (e instanceof Error && e.name === 'TokenBridgeUnavailableError') {
        setError(e.message);
      } else if (isAuthRequired(e)) {
        setError('Session expired — return to the timesheet to sign in again, then retry.');
      } else if (isRateLimit(e)) {
        setError('Toggl rate limit reached — wait a moment, then try again.');
      } else {
        // Everything else, said as it happened rather than guessed at. This
        // branch used to blame Toggl for anything it did not recognise, which
        // covers the whole render-and-sign half of the pipeline too: a font
        // that would not load, a widget that would not fit, a card pulled
        // mid-signature all reported themselves as a failed download, and the
        // only honest next step was the console.
        console.error('Export failed', e);
        const detail = e instanceof Error ? e.message : String(e);
        setError(
          detail
            ? `The export failed: ${detail}`
            : 'The export failed, and gave no reason. The browser console has the error.'
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

        {!rangeValid && (
          <p className="err-msg">
            Empty range — the “to” day is before the “from” day. A week or month preset
            collapses like this when it ends before the workspace start date below: there is
            nothing billable to export there.
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
            First billable day of this engagement. The week and month presets never reach
            before it — a workspace that started mid-month exports, say, Aug 16–31 as its
            first month instead of a document claiming the whole of August. Remembered with{' '}
            {fieldsScope ? <strong>{fieldsScope}</strong> : 'this device'} as you type; leave
            it empty when the engagement began on (or before) a clean month. Hand-edited
            dates are yours — only the presets are clipped.
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
            <label htmlFor="exp-role">Role ({ENGAGEMENT_LABELS[tplLocale]})</label>
            <input
              id="exp-role"
              type="text"
              value={roles[tplLocale]}
              placeholder={
                roles[tplLocale === 'cs' ? 'en' : 'cs'].trim()
                  ? `Empty = “${roles[tplLocale === 'cs' ? 'en' : 'cs'].trim()}”`
                  : 'e.g. your role on the project'
              }
              onChange={(e) => {
                const v = e.target.value;
                setRoles((prev) => ({ ...prev, [tplLocale]: v }));
                setDone(null);
              }}
            />
            <p className="hint">
              Each template language keeps its own wording (Integration architect /
              Integrační architekt); switching template shows the other one, and a language
              left empty prints the other language&apos;s text.{' '}
              {fieldsScope ? (
                <>
                  These details are remembered for the next export of{' '}
                  <strong>{fieldsScope}</strong> — every workspace keeps its own set, so another
                  client&apos;s company or rate never lands on this sheet.
                </>
              ) : (
                <>These details are remembered on this device for the next export.</>
              )}{' '}
              They follow you across devices when settings sync is on. The app itself ships no
              names or rates.
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
                onFieldsChange({ ...fields, [engagementKey(tplLocale)]: v.trim() });
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
                Pick the unit your contract quotes the rate in. The report&apos;s fee
                tables and wording follow it — an MD engagement reads man-days × MD rate
                throughout, never a recomputed hourly figure.
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
              The <strong>Prepared by</strong> box on the sign-off page becomes a real
              signature field — the issuer&apos;s box; the client&apos;s stays blank for them
              to sign. The handwritten image is cosmetic: what makes the document signed is
              the certificate, so an export with signing off stays exactly the document it
              has always been.
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
                The private key never leaves the token, so the browser cannot reach it on its
                own — <strong>Sign Bridge</strong> is the extension and helper that carry the
                request to the card and back. {describeReadiness(readiness)}
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
                  Approve the window that just appeared <strong>only</strong> if it shows the
                  code <strong>{pairingCode}</strong>. Matching them is what tells you the
                  window belongs to this page and not to something else.
                </p>
              )}
              {certificate && !certificate.qualified && (
                <p className="hint">
                  This certificate does not claim to be a qualified one on a qualified device,
                  so the export will carry a valid signature that is <strong>not</strong> a
                  QES — fine for testing the pipeline, not for a document anyone signs off.
                </p>
              )}
              {certificate && !certificate.forSignature && (
                <p className="hint">
                  This certificate&apos;s key usage does not include non-repudiation, which
                  makes it an <strong>authentication</strong> certificate rather than a signing
                  one. On a TWINS card the other entry is the one to pick.
                </p>
              )}
              {selectedBridge?.interactive && !pairingCode && (
                <p className="hint">
                  Connecting asks {selectedBridge.label.includes('Sign Bridge') ? 'Sign Bridge' : 'the helper'}{' '}
                  to approve this site once. Signing then asks for the token PIN in its own
                  window — that prompt is the signature being made, and the PIN is never typed
                  into this page.
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
                    // Let the same file be picked again after a mistake.
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
                // A file input cannot be given a value, so it says "No file
                // chosen" even when a remembered scan is in use and showing in
                // the preview below — which reads as "nothing is set" next to a
                // Remove button that plainly disagrees. Said in words instead.
                <p className="hint sig-in-use">
                  A signature scan is in use — it is the one in the preview below. Choosing a
                  file replaces it; <strong>Remove</strong> clears it.
                </p>
              )}
              <p className="hint">
                Your own scan as a <strong>PNG or JPEG</strong>, on a transparent or white
                background. It is embedded into the signature block of this export and
                remembered with{' '}
                {fieldsScope ? <strong>{fieldsScope}</strong> : 'this device'} so you need not
                pick it again — which means that, like the other export details, it is
                uploaded to your deployment and travels between your devices when settings
                sync is on. The app ships no signature image, and none is ever committed to
                the repository.
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
                The signature block at its printed size, {Math.round(signatureWidget.rect.width)}
                &nbsp;&times;&nbsp;{Math.round(signatureWidget.rect.height)}&nbsp;pt — it fills the
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
