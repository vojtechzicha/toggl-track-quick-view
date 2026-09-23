// PDF generation entry point. pdfmake and its fonts load on demand, only when
// an export runs.
//
// Accessibility limitation: pdfmake emits untagged PDF. The documents have
// real (selectable) text, embedded fonts, title/author/subject metadata and a
// /Lang entry, but no PDF/UA structure tags or reading order. pdfmake's
// `tagged: true` is not used: in pdfmake 0.2.23 it writes an empty structure
// tree (/Nums [], no marked content) while setting /Marked true, a false
// conformance claim. Tagged PDF would need a different generator; if a client
// requires PDF/UA, say so rather than implying compliance.

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ExportDoc } from '../model';
import type { PdfFontPack } from './types';
import { getTemplate } from './templates';
import { fontConfig, resolveBaseVfs } from './fonts';

export { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID, getTemplate, getDefaultTemplate } from './templates';
export type { PdfTemplate, PdfFontPack, ExportFieldName, SignatureWidget } from './types';
export { LOCALE_LABELS } from './types';
export { fontConfig, resolveBaseVfs } from './fonts';
export type { FontDecl, Vfs } from './fonts';

/** Upper bound on a render; see renderPdfMake. */
const RENDER_TIMEOUT_MS = 60_000;

/**
 * Render a pdfmake document definition to a Blob, loading pdfmake and any
 * fonts the caller supplies.
 *
 * Separate from toPDF because the visible signature stamp
 * (lib/export/pdf/sign/appearance.ts) is also a pdfmake document, one page the
 * size of the widget. Passing the template's font loader in lets the stamp use
 * the signed template's fonts.
 */
export async function renderPdfMake(
  def: TDocumentDefinitions,
  loadFonts?: () => Promise<PdfFontPack>
): Promise<Blob> {
  const [{ default: pdfMake }, fonts, extra] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    // Loaded per render so a template's fonts are fetched only when it is used.
    loadFonts ? loadFonts() : Promise.resolve(null),
  ]);

  const cfg = fontConfig(resolveBaseVfs(fonts), extra);

  return new Promise<Blob>((resolve, reject) => {
    // pdfmake's callback API has no error channel: an image it cannot decode
    // rejects inside pdfmake and the callback never fires, leaving the export
    // spinning. The signature scan is validated earlier, but the timeout turns
    // any remaining case into an error. Normal renders take under a second.
    const timer = setTimeout(() => {
      reject(new Error('PDF rendering timed out. An image in the document may be unreadable.'));
    }, RENDER_TIMEOUT_MS);

    // Fonts and vfs are passed per call, not assigned to pdfMake.fonts/.vfs.
    // Those properties come last in pdfmake's lookup
    // (`vfs || globalVfs || global.pdfMake.vfs`), and importing the vfs bundle
    // may call addVirtualFileSystem(), setting globalVfs to the Roboto-only set.
    // Whether it does depends on module evaluation order (it happened only in
    // the production bundle). Explicit arguments outrank both globals.
    // `{}` for tableLayouts keeps pdfmake from dereferencing global.pdfMake.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pdfMake as any)
      .createPdf(def, {}, cfg.fonts, cfg.vfs)
      .getBlob((blob: Blob) => {
        clearTimeout(timer);
        resolve(blob);
      });
  });
}

/** Render the document to a PDF Blob using the chosen template. */
export async function toPDF(doc: ExportDoc, templateId: string): Promise<Blob> {
  const template = getTemplate(templateId);
  return renderPdfMake(template.build(doc), template.loadFonts);
}
