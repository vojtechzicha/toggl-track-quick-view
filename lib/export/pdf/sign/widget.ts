// The one piece of geometry the signing stage owns: turning a template's
// declared signature rectangle into the rectangle a PDF widget annotation
// wants.
//
// pdfmake measures from the page's TOP-left corner and downwards; PDF measures
// from the BOTTOM-left corner and upwards. Everything else about the widget's
// position is fixed by the template (see SignatureWidget in ../templates.ts),
// so this conversion is the whole of the coordinate work — kept pure and
// exported on its own so it can be asserted directly.

import type { SignatureWidget } from '../types';

/** A PDF annotation rectangle: [x1, y1, x2, y2], bottom-left origin. */
export type PdfRect = [number, number, number, number];

/**
 * Convert a template's top-left rectangle to PDF coordinates on a page of the
 * given height.
 *
 * The page height is read from the PDF being signed rather than taken from the
 * template, so a template whose declared page size has drifted from what it
 * actually renders still places the widget over its own dashed box.
 */
export function widgetRectToPdf(
  rect: SignatureWidget['rect'],
  pageHeight: number
): PdfRect {
  const bottom = pageHeight - (rect.y + rect.height);
  return [rect.x, bottom, rect.x + rect.width, pageHeight - rect.y];
}

/** True when the rectangle fits, right way up, on a page of this size. */
export function widgetRectFits(
  rect: SignatureWidget['rect'],
  page: { width: number; height: number }
): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= 0 &&
    rect.y >= 0 &&
    rect.x + rect.width <= page.width + 0.01 &&
    rect.y + rect.height <= page.height + 0.01
  );
}
