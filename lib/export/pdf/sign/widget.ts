// Converts a template's declared signature rectangle (SignatureWidget in
// ../types.ts) into a PDF widget annotation rectangle. pdfmake measures down
// from the page's top-left corner; PDF measures up from the bottom-left.

import type { SignatureWidget } from '../types';

/** A PDF annotation rectangle: [x1, y1, x2, y2], bottom-left origin. */
export type PdfRect = [number, number, number, number];

/**
 * Convert a template's top-left rectangle to PDF coordinates on a page of the
 * given height. prepareSignature() passes the rendered page's height rather
 * than the template's declared one, so the widget still lands on the box if
 * the two drift apart.
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
