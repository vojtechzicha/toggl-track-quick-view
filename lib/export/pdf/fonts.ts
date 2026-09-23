// Font plumbing for the PDF renderer: pdfmake's bundled Roboto, plus whatever
// a template loads on top of it.

import type { FontDecl, PdfFontPack, Vfs } from './types';

export type { FontDecl, Vfs } from './types';

/**
 * pdfmake's bundled default. Declaring any font replaces the implicit set, so
 * Roboto is re-declared alongside a template's own fonts.
 */
const ROBOTO = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
};

/** pdfmake's vfs bundle has changed its export shape between versions; accept each. */
export function resolveBaseVfs(mod: unknown): Vfs {
  const f = mod as Record<string, unknown> & {
    pdfMake?: { vfs?: unknown };
    vfs?: unknown;
    default?: unknown;
  };
  return (f.pdfMake?.vfs ?? f.vfs ?? f.default ?? f) as Vfs;
}

/**
 * Font declarations and virtual file system for a render. Pure so
 * scripts/check-fonts.ts can assert every declared file exists in the vfs; a
 * mismatch otherwise fails deep inside pdfmake at render time.
 */
export function fontConfig(
  baseVfs: Vfs,
  extra: PdfFontPack | null
): { fonts: FontDecl; vfs: Vfs } {
  return {
    fonts: { Roboto: ROBOTO, ...(extra?.fonts ?? {}) },
    vfs: { ...baseVfs, ...(extra?.vfs ?? {}) },
  };
}
