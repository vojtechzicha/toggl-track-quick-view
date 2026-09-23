// Shared shapes of the signing stage. No imports from the signing libraries:
// the export dialog imports this file, and @signpdf / PKI.js / pdf-lib must stay
// out of the main bundle (./index.ts is the lazy entry point).

/** Locales of the stamp's fixed wording; the same set as the templates. */
export type SignatureLocale = 'en' | 'cs';

/** How the handwritten image and the certificate details are arranged. */
export type SignatureLayout = 'image-left' | 'image-above';

/** The visible signature block. Every value is user-entered or read from the certificate. */
export interface SignatureAppearance {
  /**
   * The handwritten signature as a PNG or JPEG `data:` URL, or null for a
   * text-only stamp.
   *
   * The user's own scan, from the export dialog's file picker or the
   * workspace's remembered export fields (lib/exportFields). Never committed or
   * bundled; it ends up only in the appearance stream of the signed PDF.
   */
  image: string | null;
  /** Printed as the signer. Defaults to the name already on the sheet. */
  signerName: string;
  /**
   * Subject CN of the signing certificate. Empty until a certificate is chosen,
   * in which case the stamp prints `unknownCert`.
   */
  certificateCN: string;
  /**
   * Signing time in ms. Printed on the stamp and written to the signature
   * dictionary's /M, so both come from one clock.
   */
  signedAtMs: number;
  /** Free-text reason; printed only when set, and copied to /Reason. */
  reason: string;
  layout: SignatureLayout;
  /** Draw a hairline frame around the stamp (the dashed box is not printed). */
  frame: boolean;
  locale: SignatureLocale;
}

export const DEFAULT_SIGNATURE_APPEARANCE: SignatureAppearance = {
  image: null,
  signerName: '',
  certificateCN: '',
  signedAtMs: 0,
  reason: '',
  // A handwritten signature is wide and short, so it fills the box better
  // across the top than beside the text.
  layout: 'image-above',
  frame: false,
  locale: 'en',
};

/**
 * The stamp's measurements, in points.
 *
 * Shared by the pdfmake definition (./appearance.ts) and the export dialog's
 * HTML preview, which draws the block at 1 pt = 1 px. The preview is not the
 * stamp PDF in an iframe because browsers' PDF viewers ignore `view=Fit` at
 * this size.
 */
export const STAMP_STYLE = {
  /** Inner padding. */
  pad: 5,
  /** Gap between the image column and the details column. */
  gutter: 8,
  /** Share of the width the image takes in the 'image-left' layout. */
  imageColumnRatio: 0.42,
  /**
   * Font size to line height, used to reserve room for the detail lines in the
   * 'image-above' layout. The image gets the remaining height.
   *
   * A fixed image share would need re-tuning whenever the box or typeface
   * changes, and getting it wrong silently drops the date line. Calibrated in
   * IBM Plex Sans: four lines totalling 26pt of type occupy about 40pt with
   * leading and margins, plus a couple of points to spare.
   */
  lineHeightFactor: 1.55,
  /**
   * Slack below the detail lines, because the reserve above is an estimate. If
   * it comes out short, pdfmake moves the overflow to a second page and only
   * the first page becomes the appearance, so a line disappears without error.
   */
  detailsSlack: 4,
  /** Never shrink the image below this, however tight the box. */
  minImageHeight: 16,
  font: { caption: 6, name: 9, meta: 5.5 },
  /**
   * The stamp's own neutral palette. It cannot come from the template because
   * a deployment may have no template pack (lib/export/pdf/pack.ts). A template
   * can name the typeface instead (SignatureWidget.fontFamily), which carries
   * most of the resemblance.
   */
  color: {
    text: '#1A1C1E',
    muted: '#575C61',
    frame: '#E2E4E6',
    paper: '#FFFFFF',
  },
} as const;

/**
 * The image formats the signature block can carry.
 *
 * pdfmake embeds images through PDFKit, which reads only PNG and JPEG. Anything
 * else (a WebP, say) makes the render never finish rather than fail, because
 * pdfmake's callback API has no error channel. So the check runs wherever an
 * image can enter: the picker, the remembered value, and the document
 * definition.
 */
export const SIGNATURE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export const SIGNATURE_IMAGE_ACCEPT = SIGNATURE_IMAGE_MIME_TYPES.join(',');

/**
 * True when the data URL holds a PNG or a JPEG, judged by its magic bytes
 * rather than its declared type, to catch renamed or mislabelled files.
 */
export function isEmbeddableSignatureImage(dataUrl: string): boolean {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return false;
  if (!/;base64/i.test(dataUrl.slice(0, comma))) return false;
  let head: string;
  try {
    head = atob(dataUrl.slice(comma + 1, comma + 9));
  } catch {
    return false;
  }
  const byte = (i: number): number => head.charCodeAt(i);
  const png = byte(0) === 0x89 && byte(1) === 0x50 && byte(2) === 0x4e && byte(3) === 0x47;
  const jpeg = byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff;
  return png || jpeg;
}

/** The stamp's date line, to the minute. Same instant as /M. */
export function formatSignedAt(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale === 'cs' ? 'cs-CZ' : undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Fixed wording of the stamp, per locale. */
export const SIGNATURE_STRINGS: Record<
  SignatureLocale,
  { signedBy: string; certificate: string; date: string; reason: string; unknownCert: string }
> = {
  en: {
    signedBy: 'Digitally signed by',
    certificate: 'Certificate',
    date: 'Date',
    reason: 'Reason',
    unknownCert: '(certificate chosen at signing time)',
  },
  cs: {
    signedBy: 'Digitálně podepsal',
    certificate: 'Certifikát',
    date: 'Datum',
    reason: 'Důvod',
    unknownCert: '(certifikát bude zvolen při podpisu)',
  },
};
