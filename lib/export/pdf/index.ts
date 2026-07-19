// PDF generation entry point. pdfmake and its bundled fonts are lazy-loaded so the
// (sizeable) library only reaches the browser when an export actually runs.

import type { ExportDoc } from '../model';
import { getTemplate } from './templates';

export { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID } from './templates';

/** Render the document to a PDF Blob using the chosen template. */
export async function toPDF(doc: ExportDoc, templateId: string): Promise<Blob> {
  const template = getTemplate(templateId);
  const [{ default: pdfMake }, fonts, extra] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    // Templates with their own typography also pull in the embedded font module.
    template.fontset === 'report' ? import('./reportFonts') : Promise.resolve(null),
  ]);

  // pdfmake's vfs export shape has shifted between versions; cover the variants.
  const f = fonts as unknown as Record<string, unknown> & {
    pdfMake?: { vfs?: unknown };
    vfs?: unknown;
    default?: unknown;
  };
  const baseVfs = f.pdfMake?.vfs ?? f.vfs ?? f.default ?? f;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pdfMake as any).vfs = extra ? { ...(baseVfs as object), ...extra.reportVfs } : baseVfs;
  if (extra) {
    // Declaring any custom font replaces the implicit default set, so Roboto
    // (the bundled default the other templates use) must be re-declared too.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pdfMake as any).fonts = {
      Roboto: {
        normal: 'Roboto-Regular.ttf',
        bold: 'Roboto-Medium.ttf',
        italics: 'Roboto-Italic.ttf',
        bolditalics: 'Roboto-MediumItalic.ttf',
      },
      ...extra.reportFonts,
    };
  }

  const def = template.build(doc);

  return new Promise<Blob>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pdfMake as any).createPdf(def).getBlob((blob: Blob) => resolve(blob));
  });
}
