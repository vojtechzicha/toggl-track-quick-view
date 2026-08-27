// Export orchestration: turn a built document into a downloaded file in the chosen
// format. Format-specific work (and the heavy libraries it needs) lives behind the
// individual serializers, which are dynamically imported on demand.

import { type ExportDoc, isEmptyDoc } from './model';
import { toCSV } from './csv';
import { toDateInput } from './range';

export type ExportFormat = 'xlsx' | 'csv' | 'pdf';

export const FORMAT_LABELS: Record<ExportFormat, string> = {
  xlsx: 'XLSX (Excel)',
  csv: 'CSV',
  pdf: 'PDF',
};

const EXT: Record<ExportFormat, string> = { xlsx: 'xlsx', csv: 'csv', pdf: 'pdf' };

/** A filesystem-safe filename like "Timesheet - Acme - 2026-06-01_2026-06-30.pdf". */
export function exportFilename(doc: ExportDoc, format: ExportFormat): string {
  const title = (doc.title || 'Timesheet').replace(/[\\/:*?"<>|]+/g, '').trim();
  const from = toDateInput(doc.fromMs);
  const to = toDateInput(doc.toMs - 1); // inclusive last day
  return `Timesheet - ${title} - ${from}_${to}.${EXT[format]}`;
}

/** Trigger a browser download for a blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a tick so the download has reliably started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Serialize the document to the chosen format and return a Blob. */
export async function serialize(
  doc: ExportDoc,
  format: ExportFormat,
  pdfTemplateId: string
): Promise<Blob> {
  switch (format) {
    case 'csv':
      return new Blob([toCSV(doc)], { type: 'text/csv;charset=utf-8' });
    case 'xlsx': {
      const { toXLSX } = await import('./xlsx');
      return toXLSX(doc);
    }
    case 'pdf': {
      const { toPDF } = await import('./pdf');
      return toPDF(doc, pdfTemplateId);
    }
  }
}

/**
 * What the export dialog asks for when the user wants the PDF signed. Absent —
 * which is the case for every other format, and for PDF with signing switched
 * off — and the export runs exactly as it always has.
 *
 * The bridge and its certificate are chosen by the dialog rather than here:
 * that is where the user picks them, where a missing bridge has to be reported
 * before anything is generated, and where the certificate's CN is needed for
 * the preview. The types are referenced inline so this module keeps naming them
 * without importing the signing stage (and with it pdf-lib and PKI.js) into
 * every bundle that touches an export.
 */
export interface SignRequest {
  appearance: import('./pdf/sign/types').SignatureAppearance;
  bridge: import('./pdf/sign/bridge').TokenBridge;
  certificate: import('./pdf/sign/bridge').TokenCertificate;
  reason?: string;
  location?: string;
  /** Shown by a bridge that asks before it signs; see ./pdf/sign. */
  documentName?: string;
  /** Ask the configured TSA for an RFC 3161 token (PAdES-B-T); see ./pdf/sign/timestamp. */
  timestamp?: import('./pdf/sign/timestamp').TimestampOptions | false;
  /** Told which level was actually produced, since a timestamp may fail after signing. */
  onLevel?: (level: 'B-B' | 'B-T', timestampError: Error | null) => void;
}

/**
 * Sign a rendered PDF, or hand it back untouched when there is nothing to sign.
 *
 * The signing stage is imported here and only here in the export path, so it
 * stays out of the bundle until an export actually asks for a signature — and
 * an unsigned export returns the very blob `serialize` produced, byte for byte.
 */
async function maybeSign(
  blob: Blob,
  format: ExportFormat,
  pdfTemplateId: string,
  request: SignRequest | null,
  documentName?: string
): Promise<Blob> {
  if (!request || format !== 'pdf') return blob;
  request = { ...request, documentName: request.documentName ?? documentName };
  const { getTemplate } = await import('./pdf/templates');
  const template = getTemplate(pdfTemplateId);
  const widget = template.signatureWidget;
  // A template with no reserved area cannot carry a widget; exporting it
  // unsigned beats putting one somewhere arbitrary.
  if (!widget) return blob;

  const { signPdf } = await import('./pdf/sign');
  return signPdf(blob, {
    widget,
    // The stamp renders in the template's own cuts, so it reads as part of the
    // document rather than pasted onto it.
    loadFonts: template.loadFonts,
    appearance: request.appearance,
    bridge: request.bridge,
    certificate: request.certificate,
    reason: request.reason,
    location: request.location,
    documentName: request.documentName,
    timestamp: request.timestamp,
    onLevel: request.onLevel,
  });
}

/** Serialize and download in one call. Returns false when there's nothing to export. */
export async function runExport(
  doc: ExportDoc,
  format: ExportFormat,
  pdfTemplateId: string,
  sign: SignRequest | null = null
): Promise<boolean> {
  if (isEmptyDoc(doc)) return false;
  // The filename is settled before signing, so the name a hardware bridge shows
  // in its confirmation is the name the file will actually be saved under.
  const filename = exportFilename(doc, format);
  const blob = await maybeSign(
    await serialize(doc, format, pdfTemplateId),
    format,
    pdfTemplateId,
    sign,
    filename
  );
  downloadBlob(blob, filename);
  return true;
}
