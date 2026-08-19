// The visible signature block — the "stamp PDF" pattern.
//
// A signature widget's appearance is a form XObject: an arbitrary PDF content
// stream. Validators (Adobe, DSS, pyHanko) check bytes and CMS and never look
// at it, so the design is entirely free. Rather than emit drawing operators by
// hand, the block is authored WITH PDFMAKE — a one-page document exactly the
// size of the widget rectangle — and that page is embedded as the appearance
// (see ./prepare.ts). Three things fall out of that:
//
//  - the stamp inherits the export templates' fonts, colours and layout
//    language, with no second toolchain to keep in step;
//  - the design is expressed as data and measurements (SignatureAppearance and
//    STAMP_STYLE), which is what lets the export dialog draw the same block at
//    the same printed size before anything is signed;
//  - the design is data — see SignatureAppearance — so it stays configurable.
//
// The handwritten image arrives as a data: URL and is embedded only here. It is
// the user's own scan: never committed, never bundled (see lib/exportFields).

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { SignatureWidget } from '../templates';
import { renderPdfMake } from '../index';
import {
  formatSignedAt,
  isEmbeddableSignatureImage,
  SIGNATURE_STRINGS,
  STAMP_STYLE,
  type SignatureAppearance,
} from './types';

// The measurements live in ./types.ts because the export dialog's preview draws
// the same block from them at 1 pt = 1 px.
const { pad: PAD, gutter: GUTTER, imageColumnRatio: IMAGE_COLUMN_RATIO } = STAMP_STYLE;
const COLOR = STAMP_STYLE.color;

/**
 * The stamp as a pdfmake document definition: one page, exactly the widget
 * rectangle, zero margins.
 *
 * Exported (rather than inlined into the renderer) so the layout can be
 * asserted without rendering anything — see scripts/check-signature.ts.
 */
export function appearanceDocDefinition(
  rect: SignatureWidget['rect'],
  appearance: SignatureAppearance
): TDocumentDefinitions {
  const t = SIGNATURE_STRINGS[appearance.locale];
  const cn = appearance.certificateCN.trim() || t.unknownCert;

  // Last line of defence. The dialog rejects an unusable scan when it is picked
  // and refuses to carry a remembered one, so this should be unreachable — but
  // the alternative to failing here is pdfmake never calling back at all.
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
    // `fit` scales the image down to the box and never up, so a large scan and
    // a small one both land inside the stamp.
    const imageHeight = Math.max(18, innerHeight * STAMP_STYLE.imageRowRatio);
    body = {
      stack: [
        { image: appearance.image, fit: [innerWidth, imageHeight] },
        { stack: details, margin: [0, 4, 0, 0] },
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
    // Drawn absolutely so the frame never pushes the content around.
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
    // An opaque background, as a real signature stamp has: the templates print
    // a faint "sign and date here" prompt inside the reserved box, and once the
    // box IS signed that prompt has to be gone rather than showing through.
    // Inset by a point so the box's own dashed border stays the width it was
    // drawn at.
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
    defaultStyle: { fontSize: STAMP_STYLE.font.caption, color: COLOR.text },
  };
}

/** The stamp as a standalone one-page PDF — what ./prepare.ts embeds. */
export function renderAppearance(
  rect: SignatureWidget['rect'],
  appearance: SignatureAppearance
): Promise<Blob> {
  return renderPdfMake(appearanceDocDefinition(rect, appearance));
}
