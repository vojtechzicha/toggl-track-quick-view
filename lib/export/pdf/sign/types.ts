// Shared shapes of the signing stage. Deliberately free of any dependency on
// the signing libraries themselves: the export dialog imports these types to
// build its form and preview, and must not drag @signpdf / PKI.js / pdf-lib
// into the main bundle (see ./index.ts for the lazy entry point).

/** Locales the stamp's fixed wording is written in — same set as the templates. */
export type SignatureLocale = 'en' | 'cs';

/** How the handwritten image and the certificate details are arranged. */
export type SignatureLayout = 'image-left' | 'image-above';

/**
 * The visible signature block's design. Everything here is either user-entered
 * or derived from the certificate — the app ships no names, and above all no
 * signature image (see `image`).
 */
export interface SignatureAppearance {
  /**
   * The handwritten signature as a `data:image/png;base64,…` URL, or null for a
   * text-only stamp.
   *
   * This is the user's own scan. It is never committed to the repo and never
   * bundled: it arrives from the export dialog's file picker or from the
   * workspace's remembered export fields (lib/exportFields), and lives only
   * inside the appearance stream of the PDF being signed.
   */
  image: string | null;
  /** Printed as the signer. Defaults to the name already on the sheet. */
  signerName: string;
  /**
   * Subject CN of the signing certificate. Empty while no certificate has been
   * chosen — phase 1 previews and unsigned fields show the placeholder instead.
   */
  certificateCN: string;
  /**
   * Signing time in ms. The stamp prints this and the signature dictionary's
   * /M entry carries it, so the visible date and the recorded one are one clock.
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
  // A handwritten signature is a wide, short image, so it fills the reserved
  // box far better across the top than beside the text.
  layout: 'image-above',
  frame: false,
  locale: 'en',
};

/**
 * The stamp's measurements, in points.
 *
 * Shared between the pdfmake definition that becomes the appearance and the
 * export dialog's preview, which draws the same block at 1 pt = 1 px — so the
 * preview is the design at its printed size rather than an impression of it.
 * (The obvious alternative, showing the stamp PDF itself in an iframe, does not
 * survive contact with the browsers' built-in PDF viewers: at 280x95pt they
 * ignore `view=Fit` and render the page at a zoom of their own choosing.)
 */
export const STAMP_STYLE = {
  /** Inner padding. */
  pad: 5,
  /** Gap between the image column and the details column. */
  gutter: 8,
  /** Share of the width the image takes in the 'image-left' layout. */
  imageColumnRatio: 0.42,
  /** Share of the height the image takes in the 'image-above' layout. */
  imageRowRatio: 0.5,
  font: { caption: 6, name: 9, meta: 5.5 },
  color: { text: '#1f2937', muted: '#6b7280', frame: '#9ca3af' },
} as const;

/**
 * The image formats the signature block can actually carry.
 *
 * pdfmake embeds images through PDFKit, which reads PNG and JPEG and nothing
 * else. A browser will happily display (and a file picker happily accept) a
 * WebP, so the mismatch only surfaces at render time — and pdfmake's callback
 * API has no error channel, so it surfaces as a render that never finishes
 * rather than as a message. Hence the check, and hence it being applied
 * wherever an image can enter: the picker, the remembered value, and the
 * document definition itself.
 */
export const SIGNATURE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg'] as const;
export const SIGNATURE_IMAGE_ACCEPT = SIGNATURE_IMAGE_MIME_TYPES.join(',');

/**
 * True when the data URL holds a PNG or a JPEG, judged by its first bytes
 * rather than by the type it claims — a renamed or mislabelled file is exactly
 * the case worth catching.
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
