// Font plumbing for the PDF renderer: pdfmake's bundled Roboto, plus whatever
// a template loads on top of it.

import type { FontDecl, PdfFontPack, Vfs } from './types';

export type { FontDecl, Vfs } from './types';

/**
 * pdfmake's bundled default. Declaring any custom font replaces the implicit
 * set, so Roboto has to be re-declared alongside a template's own cuts.
 */
const ROBOTO = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
};

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
  extra: PdfFontPack | null
): { fonts: FontDecl; vfs: Vfs } {
  return {
    fonts: { Roboto: ROBOTO, ...(extra?.fonts ?? {}) },
    vfs: { ...baseVfs, ...(extra?.vfs ?? {}) },
  };
}
