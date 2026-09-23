// The visible signature block ("stamp PDF" pattern).
//
// A signature widget's appearance is a form XObject, an arbitrary content
// stream that validators never inspect. The block is laid out with pdfmake as a
// one-page document the size of the widget rectangle, and ./prepare.ts embeds
// that page as the appearance. The layout is driven by SignatureAppearance and
// STAMP_STYLE (./types.ts), which the export dialog's preview also uses.
//
// The handwritten image is the user's own scan, passed in as a data: URL and
// embedded only here.

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { PdfFontPack, SignatureWidget } from '../types';
import { renderPdfMake } from '../index';
import {
  formatSignedAt,
  isEmbeddableSignatureImage,
  SIGNATURE_STRINGS,
  STAMP_STYLE,
  type SignatureAppearance,
} from './types';

const { pad: PAD, gutter: GUTTER, imageColumnRatio: IMAGE_COLUMN_RATIO } = STAMP_STYLE;

/** Gap between the image and the detail lines below it. */
const DETAILS_GAP = 4;
const COLOR = STAMP_STYLE.color;

/**
 * The stamp as a pdfmake document definition: one page the size of the widget
 * rectangle. Exported so scripts/check-signature.ts can assert on it without
 * rendering.
 */
export function appearanceDocDefinition(
  rect: SignatureWidget['rect'],
  appearance: SignatureAppearance,
  fontFamily?: string
): TDocumentDefinitions {
  const t = SIGNATURE_STRINGS[appearance.locale];
  const cn = appearance.certificateCN.trim() || t.unknownCert;

  // The dialog already rejects unusable images, but if one gets through,
  // pdfmake would never call back. Fail here instead.
  if (appearance.image && !isEmbeddableSignatureImage(appearance.image)) {
    throw new Error('The signature image must be a PNG or a JPEG.');
  }

  const details: Content[] = [
    { text: t.signedBy, style: 'sigCaption' },
    { text: appearance.signerName.trim() || '—', style: 'sigName' },
    { text: `${t.certificate}: ${cn}`, style: 'sigMeta' },
    { text: `${t.date}: ${formatSignedAt(appearance.signedAtMs, appearance.locale)}`, style: 'sigMeta' },
  ];
  if (appearance.reason.trim()) {
    details.push({ text: `${t.reason}: ${appearance.reason.trim()}`, style: 'sigMeta' });
  }

  const innerWidth = rect.width - 2 * PAD;
  const innerHeight = rect.height - 2 * PAD;

  let body: Content;
  if (!appearance.image) {
    body = { stack: details };
  } else if (appearance.layout === 'image-above') {
    // Reserve what the detail lines need and give the image the rest (see
    // STAMP_STYLE.lineHeightFactor). `fit` scales the image, up or down, to fit
    // that box with its aspect ratio kept.
    const f = STAMP_STYLE.font;
    const detailsHeight =
      (f.caption + f.name + f.meta * (details.length - 2)) * STAMP_STYLE.lineHeightFactor +
      DETAILS_GAP;
    const imageHeight = Math.max(
      STAMP_STYLE.minImageHeight,
      innerHeight - detailsHeight - STAMP_STYLE.detailsSlack
    );
    body = {
      stack: [
        { image: appearance.image, fit: [innerWidth, imageHeight] },
        { stack: details, margin: [0, DETAILS_GAP, 0, 0] },
      ],
    };
  } else {
    const imageWidth = innerWidth * IMAGE_COLUMN_RATIO;
    body = {
      columns: [
        {
          width: imageWidth,
          stack: [{ image: appearance.image, fit: [imageWidth, innerHeight] }],
        },
        { width: '*', stack: details },
      ],
      columnGap: GUTTER,
    };
  }

  const content: Content[] = [body];
  if (appearance.frame) {
    // Absolutely positioned so the frame does not affect the layout.
    content.push({
      absolutePosition: { x: 0.5, y: 0.5 },
      canvas: [
        {
          type: 'rect',
          x: 0,
          y: 0,
          w: rect.width - 1,
          h: rect.height - 1,
          lineWidth: 0.5,
          lineColor: COLOR.frame,
        },
      ],
    });
  }

  return {
    pageSize: { width: rect.width, height: rect.height },
    pageMargins: [PAD, PAD, PAD, PAD],
    // Opaque, to cover the "sign and date here" prompt the templates print in
    // the reserved box. Inset by a point so the box's dashed border stays
    // visible at full width.
    background: () => ({
      canvas: [
        {
          type: 'rect',
          x: 1,
          y: 1,
          w: rect.width - 2,
          h: rect.height - 2,
          color: COLOR.paper,
        },
      ],
    }),
    content,
    styles: {
      sigCaption: { fontSize: STAMP_STYLE.font.caption, color: COLOR.muted },
      sigName: {
        fontSize: STAMP_STYLE.font.name,
        bold: true,
        color: COLOR.text,
        margin: [0, 1, 0, 2],
      },
      sigMeta: { fontSize: STAMP_STYLE.font.meta, color: COLOR.muted, margin: [0, 0.5, 0, 0] },
    },
    // The template's own family (SignatureWidget.fontFamily), so the stamp
    // matches the page. Undefined leaves pdfmake on its bundled Roboto, which
    // is also what a template without embedded fonts uses.
    defaultStyle: {
      ...(fontFamily ? { font: fontFamily } : {}),
      fontSize: STAMP_STYLE.font.caption,
      color: COLOR.text,
    },
  };
}

/**
 * The stamp as a standalone one-page PDF, which ./prepare.ts embeds.
 *
 * Takes the whole widget because it also names the font family. Pass the
 * template's own `loadFonts` so that family is available.
 */
export function renderAppearance(
  widget: SignatureWidget,
  appearance: SignatureAppearance,
  loadFonts?: () => Promise<PdfFontPack>
): Promise<Blob> {
  return renderPdfMake(
    appearanceDocDefinition(widget.rect, appearance, widget.fontFamily),
    loadFonts
  );
}
