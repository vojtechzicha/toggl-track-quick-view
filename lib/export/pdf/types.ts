// The PDF template contract: all the app knows about a template.
//
// Imports only the document model and pdfmake's types, so a template pack
// (./pack.ts) can depend on it without pulling in the app. The export dialog
// builds its inputs from these declarations.
//
// Field-by-field guide: README.md → "Adding a PDF template".

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ExportDoc } from '../model';

/**
 * Identity fields a template can ask the export dialog for, beyond the
 * person's name and the period. Values are user-entered and remembered per
 * workspace (lib/exportFields). They arrive on ExportDoc under the same names;
 * 'rate' fills `rate`, `rateBasis` and `currency`.
 */
export type ExportFieldName =
  | 'role'
  | 'company'
  | 'client'
  | 'approver'
  | 'reference'
  | 'engagement'
  | 'rate';

/** pdfmake font declarations: family → cut → filename inside the VFS. */
export type FontDecl = Record<string, Record<string, string>>;
/** pdfmake's virtual file system: filename → base64 font data. */
export type Vfs = Record<string, string>;

/**
 * Extra embedded fonts a template renders with. Declarations and data travel
 * together because pdfmake looks each declared filename up in the VFS and a
 * mismatch fails at render time (scripts/check-fonts.ts asserts they agree).
 */
export interface PdfFontPack {
  vfs: Vfs;
  fonts: FontDecl;
}

/**
 * Where a signable template puts its signature widget. This is the whole
 * interface between a template and the signing stage (lib/export/pdf/sign),
 * which owns the certificate, CMS, timestamp and visible stamp.
 *
 * The rectangle is in pdfmake coordinates (points from the top-left corner)
 * and must be free on the last page. The signing stage converts it to the
 * PDF's bottom-left origin (lib/export/pdf/sign/widget.ts).
 *
 * The rect is a promise by the template, not a measurement: the rendered PDF
 * does not record where a flowing block landed. A template that declares it
 * must put its signature block at that fixed position and keep other content
 * out of it, e.g. with an invisible reserve node plus a `pageBreakBefore` rule
 * keyed on its id.
 */
export interface SignatureWidget {
  rect: { x: number; y: number; width: number; height: number };
  /** Page size the rect is expressed against (`pnpm check:signature` asserts it fits). */
  page: { width: number; height: number };
  /**
   * pdfmake font family for the visible stamp's text, so it matches the
   * document. Must be declared by the template's `loadFonts()`. Omitted =
   * Roboto.
   */
  fontFamily?: string;
}

export interface PdfTemplate {
  /**
   * Stable identifier, remembered as a device's last pick. Rename freely;
   * don't change the id.
   */
  id: string;
  /** Name in the export dialog's template picker. */
  name: string;
  /** One or two sentences shown under the picker. */
  description: string;
  /**
   * Extra identity fields this template prints; the dialog shows an input for
   * each. 'rate' shows rate, currency and the hour/man-day unit.
   */
  fields?: ExportFieldName[];
  /**
   * Placeholder text per field. Useful for free-text fields such as the
   * engagement note, as an example in the template's language.
   */
  fieldHints?: Partial<Record<ExportFieldName, string>>;
  /**
   * Language the template prints in. The dialog keeps the role and engagement
   * note separately per language.
   */
  locale?: 'en' | 'cs';
  /**
   * Loads the extra fonts this template's styles use. Called only when the
   * template renders. Omit to use pdfmake's bundled Roboto.
   */
  loadFonts?: () => Promise<PdfFontPack>;
  /**
   * Set when the template reserves a signature area; this is what makes it
   * signable. Without it the dialog offers no signing, since a stamp would
   * land on top of content.
   */
  signatureWidget?: SignatureWidget;
  /** Turn the export document into a pdfmake document definition. */
  build: (doc: ExportDoc) => TDocumentDefinitions;
}

/**
 * Templates supplied from outside the app; a pack's default export (see
 * ./pack.ts and scripts/sync-pack.mjs).
 */
export interface TemplatePack {
  /** Display name of the pack. */
  name: string;
  templates: PdfTemplate[];
  /**
   * Template selected when a device has no remembered pick. Omitted = the
   * first template in the registry.
   */
  defaultTemplateId?: string;
}

/** Language names for the locale a template prints in (dialog labels). */
export const LOCALE_LABELS: Record<'en' | 'cs', string> = {
  en: 'English',
  cs: 'Czech',
};
