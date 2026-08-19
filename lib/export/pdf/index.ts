// PDF generation entry point. pdfmake and its bundled fonts are lazy-loaded so the
// (sizeable) library only reaches the browser when an export actually runs.

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ExportDoc } from '../model';
import { getTemplate } from './templates';

export { PDF_TEMPLATES, DEFAULT_TEMPLATE_ID } from './templates';
export type { PdfTemplate, SignatureWidget } from './templates';

/**
 * pdfmake's bundled default. Declaring any custom font replaces the implicit
 * set, so Roboto has to be re-declared alongside the report's own cuts.
 */
const ROBOTO = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
};

export type FontDecl = Record<string, Record<string, string>>;
export type Vfs = Record<string, string>;

/** pdfmake's vfs bundle has changed export shape between versions; cover the variants. */
export function resolveBaseVfs(mod: unknown): Vfs {
  const f = mod as Record<string, unknown> & {
    pdfMake?: { vfs?: unknown };
    vfs?: unknown;
    default?: unknown;
  };
  return (f.pdfMake?.vfs ?? f.vfs ?? f.default ?? f) as Vfs;
}

/**
 * Assemble the font declarations and the virtual file system for a render.
 *
 * Kept pure and exported so the pairing can be checked directly: every file a
 * declaration names must exist in the vfs. A mismatch fails at render time deep
 * inside pdfmake ("File 'X.ttf' not found in virtual file system"), so it is
 * worth asserting up front — see scripts/check-fonts.ts.
 */
export function fontConfig(
  baseVfs: Vfs,
  extra: { reportVfs: Vfs; reportFonts: FontDecl } | null
): { fonts: FontDecl; vfs: Vfs } {
  return {
    fonts: { Roboto: ROBOTO, ...(extra?.reportFonts ?? {}) },
    vfs: { ...baseVfs, ...(extra?.reportVfs ?? {}) },
  };
}

/**
 * Render a pdfmake document definition to a Blob, lazy-loading the library and
 * the requested fontset.
 *
 * Shared with the signature stamp (lib/export/pdf/sign/appearance.ts), which is
 * authored with pdfmake too so the visible signature block inherits the export
 * templates' fonts and layout language.
 */
export async function renderPdfMake(
  def: TDocumentDefinitions,
  fontset?: 'report'
): Promise<Blob> {
  const [{ default: pdfMake }, fonts, extra] = await Promise.all([
    import('pdfmake/build/pdfmake'),
    import('pdfmake/build/vfs_fonts'),
    // Templates with their own typography also pull in the embedded font module.
    fontset === 'report' ? import('./reportFonts') : Promise.resolve(null),
  ]);

  const cfg = fontConfig(resolveBaseVfs(fonts), extra);

  return new Promise<Blob>((resolve) => {
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
      .getBlob((blob: Blob) => resolve(blob));
  });
}

/** Render the document to a PDF Blob using the chosen template. */
export async function toPDF(doc: ExportDoc, templateId: string): Promise<Blob> {
  const template = getTemplate(templateId);
  return renderPdfMake(template.build(doc), template.fontset);
}
