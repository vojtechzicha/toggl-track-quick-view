// The PDF template registry the export dialog reads.
//
// This repository ships APP_TEMPLATES; an optional pack (./pack.ts) adds its
// own, listed first since a deployment that configures a pack mostly uses its
// layouts. To add a layout, add a PdfTemplate (./types) here or in a pack.

import type { PdfTemplate } from './types';
import { templatePack } from './pack';
import { timesheetTemplate } from './timesheet';

export type { PdfTemplate, PdfFontPack, ExportFieldName, TemplatePack } from './types';

/** The templates this repository ships. */
export const APP_TEMPLATES: PdfTemplate[] = [timesheetTemplate];

export const PDF_TEMPLATES: PdfTemplate[] = [...templatePack.templates, ...APP_TEMPLATES];

/** Used when a device has no remembered pick: the pack's choice, else the first template. */
export const DEFAULT_TEMPLATE_ID: string =
  (templatePack.defaultTemplateId &&
    PDF_TEMPLATES.find((t) => t.id === templatePack.defaultTemplateId)?.id) ||
  PDF_TEMPLATES[0].id;

/**
 * The template with this id, or the default. Falls back rather than throwing
 * because a device's remembered pick can outlive its template (a removed
 * template, or a pack no longer configured).
 */
export function getTemplate(id: string): PdfTemplate {
  return PDF_TEMPLATES.find((t) => t.id === id) ?? getDefaultTemplate();
}

export function getDefaultTemplate(): PdfTemplate {
  return PDF_TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID) ?? PDF_TEMPLATES[0];
}
