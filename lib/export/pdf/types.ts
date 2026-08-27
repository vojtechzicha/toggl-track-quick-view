// The PDF template contract — everything a template has to say about itself,
// and the only thing the app knows about one.
//
// This module is the boundary between the app and its templates. It imports
// nothing but the document model and pdfmake's types, so a template pack
// (lib/export/pdf/pack.ts) can depend on it without dragging the app in, and
// the export dialog can drive its inputs entirely off what a template
// declares. Adding a layout means adding a PdfTemplate — nothing else in the
// pipeline is template-aware.
//
// See README.md → "Adding a PDF template" for the field-by-field guide.

import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { ExportDoc } from '../model';

/**
 * Identity fields a template can ask the export dialog for, beyond the
 * person's name and the period (which every document gets). Their values are
 * always user-entered — the app ships no company names, clients or rates — and
 * are remembered with the workspace being billed (see lib/exportFields).
 *
 * They arrive on ExportDoc under the same names; 'rate' fills `rate`,
 * `rateBasis` and `currency`.
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
 * together on purpose: pdfmake resolves a style to a filename and then looks
 * that filename up in the VFS, so a pair that disagrees fails deep inside the
 * library at render time (scripts/check-fonts.ts asserts they agree).
 */
export interface PdfFontPack {
  vfs: Vfs;
  fonts: FontDecl;
}

/**
 * Where a signable template puts its signature widget.
 *
 * This is the whole interface between a template and the signing stage, and it
 * is deliberately DATA — a rectangle, a page size, a font name. Everything that
 * makes a signature a signature (the card, the CMS, the timestamp, the visible
 * stamp) is the app's, in lib/export/pdf/sign; a template neither performs nor
 * knows about any of it. That split is what lets a pack be a private repository
 * of layouts rather than a second implementation of PAdES.
 *
 * The rectangle is in pdfmake's coordinates — points from the page's TOP-left
 * corner — and must be free on the document's LAST page. The signing stage
 * converts it to the PDF's bottom-left origin against the page it actually
 * finds (lib/export/pdf/sign/widget.ts).
 *
 * It is a GUARANTEE, not a report. A finished blob carries no metadata about
 * where a flowing signature block landed — its page and Y vary with the number
 * of table rows — so a template that declares this must place its block at a
 * fixed position and keep the flow out of that band. The pack's report template
 * shows the two halves of that: an invisible reserve node sized to the row,
 * plus a `pageBreakBefore` rule keyed on its id.
 */
export interface SignatureWidget {
  rect: { x: number; y: number; width: number; height: number };
  /** Page size the rect is expressed against; a mismatch means a wrong contract. */
  page: { width: number; height: number };
  /**
   * pdfmake font family the visible stamp sets its text in.
   *
   * Named by the template because the stamp is dropped INTO its document and
   * should read as part of it rather than pasted on. Must be a family the
   * template's own `loadFonts()` declares. Omitted falls back to pdfmake's
   * bundled Roboto, which is also what a template with no `loadFonts` gets.
   */
  fontFamily?: string;
}

export interface PdfTemplate {
  /**
   * Stable identifier. It is what a device remembers as its last pick, so
   * renaming a template is free but changing its id is not.
   */
  id: string;
  /** Name in the export dialog's template picker. */
  name: string;
  /** One or two sentences shown under the picker once the template is chosen. */
  description: string;
  /**
   * Extra identity fields this template prints. The export dialog shows an
   * input for each — 'rate' renders as a rate + currency pair with a switch
   * for what the rate is quoted per (an hour, or a man-day).
   */
  fields?: ExportFieldName[];
  /**
   * Placeholder text for those inputs, per field. Use it for a field whose
   * wording the user has to phrase themselves (the engagement note): a worked
   * example in the template's own language says more than a label can.
   */
  fieldHints?: Partial<Record<ExportFieldName, string>>;
  /**
   * Language the template prints in. The export dialog uses it for the fields
   * the user must phrase themselves (the engagement note), so each language
   * keeps its own text rather than one being pasted into the other.
   */
  locale?: 'en' | 'cs';
  /**
   * Extra fonts this template's styles reference, loaded on demand — it runs
   * only when the template actually renders, so an embedded typeface never
   * reaches a browser exporting through a different template. Templates that
   * stay on pdfmake's bundled Roboto leave it out.
   */
  loadFonts?: () => Promise<PdfFontPack>;
  /**
   * Present when the template reserves a signature area — and the only thing
   * that makes a template signable. Absent means the export dialog offers no
   * signing for it at all, which is the right default: a signature stamped
   * over a layout that reserved no room for it lands on top of the content.
   */
  signatureWidget?: SignatureWidget;
  /** Turn the export document into a pdfmake document definition. */
  build: (doc: ExportDoc) => TDocumentDefinitions;
}

/**
 * A set of templates supplied from outside the app — see lib/export/pdf/pack.ts
 * and scripts/sync-pack.mjs. A pack module's default export is one of these.
 */
export interface TemplatePack {
  /** Human name, for the "no pack configured" / "pack loaded" build log line. */
  name: string;
  templates: PdfTemplate[];
  /**
   * Template selected when a device has no remembered pick. Defaults to the
   * app's own first template, so a pack only sets this when its own layout
   * should lead.
   */
  defaultTemplateId?: string;
}

/** Language names for the locale a template prints in (dialog labels). */
export const LOCALE_LABELS: Record<'en' | 'cs', string> = {
  en: 'English',
  cs: 'Czech',
};
