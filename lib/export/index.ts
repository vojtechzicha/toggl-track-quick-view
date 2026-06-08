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

/** Serialize and download in one call. Returns false when there's nothing to export. */
export async function runExport(
  doc: ExportDoc,
  format: ExportFormat,
  pdfTemplateId: string
): Promise<boolean> {
  if (isEmptyDoc(doc)) return false;
  const blob = await serialize(doc, format, pdfTemplateId);
  downloadBlob(blob, exportFilename(doc, format));
  return true;
}
