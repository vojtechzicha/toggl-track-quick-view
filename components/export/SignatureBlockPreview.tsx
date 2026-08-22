'use client';

// The export dialog's preview of the visible signature block.
//
// It draws the same block the signed PDF will carry, from the same appearance
// values and the same measurements (STAMP_STYLE), at 1 pt = 1 px — so what is
// on screen is the design at its printed size, not an impression of it.
//
// It is HTML rather than the stamp PDF in an iframe, which is what this started
// as: at a couple of hundred points across, the browsers' built-in PDF
// viewers ignore `#view=Fit` and
// render the page at a zoom of their own, so the preview showed a corner of the
// block blown up. The measurements are shared with the pdfmake definition, so
// the two cannot drift on size or spacing — only a change to the pdfmake
// *structure* needs mirroring here, and there is exactly one structure per
// layout.

import {
  formatSignedAt,
  SIGNATURE_STRINGS,
  STAMP_STYLE,
  type SignatureAppearance,
} from '@/lib/export/pdf/sign/types';

export interface SignatureBlockPreviewProps {
  /** The widget rectangle, in points — the block's printed size. */
  rect: { width: number; height: number };
  appearance: SignatureAppearance;
}

export default function SignatureBlockPreview({ rect, appearance }: SignatureBlockPreviewProps) {
  const t = SIGNATURE_STRINGS[appearance.locale];
  const cn = appearance.certificateCN.trim() || t.unknownCert;
  const { pad, gutter, imageColumnRatio, lineHeightFactor, detailsSlack, minImageHeight, font, color } =
    STAMP_STYLE;
  const innerWidth = rect.width - 2 * pad;
  const innerHeight = rect.height - 2 * pad;
  const above = appearance.layout === 'image-above';

  const details = (
    <div>
      <div style={{ fontSize: font.caption, color: color.muted, lineHeight: 1.2 }}>
        {t.signedBy}
      </div>
      <div
        style={{
          fontSize: font.name,
          fontWeight: 600,
          color: color.text,
          lineHeight: 1.2,
          margin: '1px 0 2px',
        }}
      >
        {appearance.signerName.trim() || '—'}
      </div>
      <div style={{ fontSize: font.meta, color: color.muted, lineHeight: 1.3 }}>
        {t.certificate}: {cn}
      </div>
      <div style={{ fontSize: font.meta, color: color.muted, lineHeight: 1.3 }}>
        {t.date}: {formatSignedAt(appearance.signedAtMs, appearance.locale)}
      </div>
      {appearance.reason.trim() && (
        <div style={{ fontSize: font.meta, color: color.muted, lineHeight: 1.3 }}>
          {t.reason}: {appearance.reason.trim()}
        </div>
      )}
    </div>
  );

  return (
    <div
      className="sig-preview"
      style={{
        width: rect.width,
        height: rect.height,
        padding: pad,
        border: appearance.frame ? `0.5px solid ${color.frame}` : undefined,
      }}
    >
      {appearance.image ? (
        <div
          style={{
            display: 'flex',
            flexDirection: above ? 'column' : 'row',
            gap: above ? 4 : gutter,
            height: innerHeight,
          }}
        >
          {/* `contain` mirrors pdfmake's `fit`: scale down into the box, never up. */}
          <img
            alt=""
            src={appearance.image}
            style={{
              width: above ? innerWidth : innerWidth * imageColumnRatio,
              // Same arithmetic as the exported stamp (see sign/appearance.ts):
              // the detail lines take what they need and the image gets the
              // rest, so the preview shows the proportions that will print.
              height: above
                ? Math.max(
                    minImageHeight,
                    innerHeight -
                      ((font.caption + font.name + font.meta * (appearance.reason.trim() ? 3 : 2)) *
                        lineHeightFactor +
                        4 +
                        detailsSlack)
                  )
                : innerHeight,
              objectFit: 'contain',
              objectPosition: 'left top',
            }}
          />
          {details}
        </div>
      ) : (
        details
      )}
    </div>
  );
}
