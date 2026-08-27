// PDF generation entry point. pdfmake and its bundled fonts are lazy-loaded so the
// (sizeable) library only reaches the browser when an export actually runs.
//
// Known generator limitation — accessibility: pdfmake emits UNTAGGED PDF.
// The documents carry real text (selectable, searchable), embedded genuine
// font cuts, title/author/subject metadata and a /Lang entry (the
// `language` doc property), but no PDF/UA structure tags or explicit reading
// order. pdfmake's own `tagged: true` flag is NOT used deliberately: it was
// verified (pdfmake 0.2.23) to emit an empty structure tree (/Nums [],
// no marked content) while stamping /Marked true — a false conformance
// claim, worse than honestly untagged output. Producing genuinely tagged
// PDF would require a different generator; if a client demands PDF/UA,
// state this limitation rather than implying compliance.

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

/** See renderPdfMake: a ceiling on a render that can otherwise never finish. */
const RENDER_TIMEOUT_MS = 60_000;

/**
 * Render a pdfmake document definition to a Blob, lazy-loading the library and
 * whatever fonts the caller asks for.
 *
 * Separate from toPDF because the visible signature stamp is authored with
 * pdfmake too (lib/export/pdf/sign/appearance.ts): it is a one-page document
 * the size of the widget, and rendering it through the same path is what lets
 * it set type in the SIGNED TEMPLATE'S font rather than in one the app picked.
 * The app has no fonts of its own to offer — a pack owns its typography — so
 * the loader is passed in.
 */
export async function renderPdfMake(
  def: TDocumentDefinitions,
  loadFonts?: () => Promise<PdfFontPack>
): Promise<Blob> {
  const [{ default: pdfMake }, fonts, extra] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    // A template with its own typography loads its cuts here, so an embedded
    // typeface never reaches a browser exporting through a different template.
    loadFonts ? loadFonts() : Promise.resolve(null),
  ]);

  const cfg = fontConfig(resolveBaseVfs(fonts), extra);

  return new Promise<Blob>((resolve, reject) => {
    // pdfmake's callback API has no error channel. An image it cannot decode
    // rejects inside its own promise chain and the callback is simply never
    // called, so the caller waits forever — an export button that spins for the
    // rest of the session. Only user-supplied images can realistically trigger
    // it (the signature scan, which is checked before it gets here), but a
    // ceiling turns any residual case into a message. Everything this app
    // renders takes well under a second.
    const timer = setTimeout(() => {
      reject(new Error('PDF rendering did not finish — an image in the document may be unusable.'));
    }, RENDER_TIMEOUT_MS);

    // Everything is passed per call rather than assigned to pdfMake.vfs /
    // pdfMake.fonts. Those properties sit *last* in pdfmake's precedence chain
    // (`vfs || globalVfs || global.pdfMake.vfs`), and importing the vfs bundle
    // can call addVirtualFileSystem() as a side effect — which sets globalVfs to
    // the Roboto-only set and silently outranks anything we assign. Whether that
    // side effect fires depends on module evaluation order, so it showed up only
    // in the production bundle. The explicit arguments outrank both globals.
    // `{}` for tableLayouts keeps the chain from dereferencing global.pdfMake.
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
