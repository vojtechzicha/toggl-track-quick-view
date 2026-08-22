// The PDF template registry — the one list the export dialog reads.
//
// Templates come from two places: this repository ships APP_TEMPLATES, and an
// optional external pack (lib/export/pdf/pack.ts) may add its own. A plain
// clone has no pack, so it offers exactly the app's templates; a deployment
// that configures one gets its layouts first in the picker, because the pack a
// deployment went to the trouble of wiring in is the one its documents are
// actually filed under.
//
// Adding a layout means adding a PdfTemplate (./types) — either here or in a
// pack. Nothing else in the export pipeline is template-aware.

import type { PdfTemplate } from './types';
import { templatePack } from './pack';
import { timesheetTemplate } from './timesheet';

export type { PdfTemplate, PdfFontPack, ExportFieldName, TemplatePack } from './types';

/** The templates this repository ships. */
export const APP_TEMPLATES: PdfTemplate[] = [timesheetTemplate];

export const PDF_TEMPLATES: PdfTemplate[] = [...templatePack.templates, ...APP_TEMPLATES];

/**
 * The pick a device with no remembered choice gets. A pack may name one of its
 * own; otherwise the first template in the list leads.
 */
export const DEFAULT_TEMPLATE_ID: string =
  (templatePack.defaultTemplateId &&
    PDF_TEMPLATES.find((t) => t.id === templatePack.defaultTemplateId)?.id) ||
  PDF_TEMPLATES[0].id;

/**
 * The template with this id, or the default one. Resolving rather than failing
 * is deliberate: a device remembers its last pick, and a pack that stops being
 * configured (or a template that is removed) must not leave the export dialog
 * unable to produce anything.
 */
export function getTemplate(id: string): PdfTemplate {
  return PDF_TEMPLATES.find((t) => t.id === id) ?? getDefaultTemplate();
}

export function getDefaultTemplate(): PdfTemplate {
  return PDF_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ?? PDF_TEMPLATES[0];
}
