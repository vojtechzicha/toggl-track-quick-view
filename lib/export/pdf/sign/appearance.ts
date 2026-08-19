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
//  - it is previewable in the export dialog before anything is signed, because
//    a preview is just the same page rendered on its own;
//  - the design is data — see SignatureAppearance — so it stays configurable.
//
// The handwritten image arrives as a data: URL and is embedded only here. It is
// the user's own scan: never committed, never bundled (see lib/exportFields).

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { SignatureWidget } from '../templates';
import { renderPdfMake } from '../index';
import { SIGNATURE_STRINGS, type SignatureAppearance } from './types';

/** Inner padding of the stamp, in points. */
const PAD = 5;
/** Gap between the image column and the details column. */
const GUTTER = 8;
/** Share of the width the image column takes in the 'image-left' layout. */
const IMAGE_COLUMN_RATIO = 0.42;

const COLOR = {
  text: '#1f2937',
  muted: '#6b7280',
  frame: '#9ca3af',
};

/** The stamp's date line — the same clock /M records, printed to the minute. */
export function formatSignedAt(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale === 'cs' ? 'cs-CZ' : undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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
    const imageHeight = Math.max(18, innerHeight * 0.5);
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
    content,
    styles: {
      sigCaption: { fontSize: 6, color: COLOR.muted },
      sigName: { fontSize: 9, bold: true, color: COLOR.text, margin: [0, 1, 0, 2] },
      sigMeta: { fontSize: 5.5, color: COLOR.muted, margin: [0, 0.5, 0, 0] },
    },
    defaultStyle: { fontSize: 6, color: COLOR.text },
  };
}

/**
 * The stamp as a standalone one-page PDF Blob — what the export dialog shows as
 * a preview, and what ./prepare.ts embeds as the widget's appearance.
 */
export function renderAppearance(
  rect: SignatureWidget['rect'],
  appearance: SignatureAppearance
): Promise<Blob> {
  return renderPdfMake(appearanceDocDefinition(rect, appearance));
}
