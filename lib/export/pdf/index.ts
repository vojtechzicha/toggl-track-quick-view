// PDF generation entry point. pdfmake and its bundled fonts are lazy-loaded so the
// (sizeable) library only reaches the browser when an export actually runs.

import type { ExportDoc } from '../model';
import { getTemplate } from './templates';

export { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID } from './templates';

/** Render the document to a PDF Blob using the chosen template. */
export async function toPDF(doc: ExportDoc, templateId: string): Promise<Blob> {
  const [{ default: pdfMake }, fonts] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
  ]);

  // pdfmake's vfs export shape has shifted between versions; cover the variants.
  const f = fonts as unknown as Record<string, unknown> & {
    pdfMake?: { vfs?: unknown };
    vfs?: unknown;
    default?: unknown;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfMake as any).vfs = f.pdfMake?.vfs ?? f.vfs ?? f.default ?? f;

  const def = getTemplate(templateId).build(doc);

  return new Promise<Blob>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pdfMake as any).createPdf(def).getBlob((blob: Blob) => resolve(blob));
  });
}
