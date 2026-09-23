// Export orchestration: serialize a built document in the chosen format and
// download it. The XLSX and PDF serializers are imported on demand so their
// libraries stay out of the main bundle.

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
  // Revoke later so the download has started.
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
 * What the export dialog passes when the user wants the PDF signed; null for
 * an unsigned export.
 *
 * The dialog picks the bridge and certificate, since it has to report a missing
 * bridge before anything is generated and show the certificate's CN in the
 * preview. The types are referenced inline so this module does not import the
 * signing stage (pdf-lib, PKI.js) into every bundle that touches an export.
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
  /** Reports the level produced; the timestamp can fail after signing succeeds. */
  onLevel?: (level: 'B-B' | 'B-T', timestampError: Error | null) => void;
}

/**
 * Sign a rendered PDF, or return it unchanged when there is nothing to sign.
 * This is the only place the export path imports the signing stage, so it
 * loads only when a signature is requested.
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
  // No reserved area: export unsigned rather than place a widget arbitrarily.
  if (!widget) return blob;

  const { signPdf } = await import('./pdf/sign');
  return signPdf(blob, {
    widget,
    // The stamp is set in the template's own fonts.
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
  // Settled before signing so the name a bridge shows in its confirmation
  // matches the saved file.
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
