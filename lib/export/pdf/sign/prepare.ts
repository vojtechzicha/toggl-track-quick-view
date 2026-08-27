// Phase 1 of signing: turn a finished export into a PDF that carries an empty,
// visibly rendered signature field.
//
// Nothing cryptographic happens here. The result is a valid PDF on its own —
// Adobe Reader shows the unsigned field and its appearance — and it is also
// exactly the input @signpdf needs: a /Contents placeholder wide enough for the
// CMS and a /ByteRange it can rewrite (see ./signer.ts).
//
// Two constraints shape the implementation:
//
//  - `useObjectStreams: false` on save. Object streams would move the signature
//    dictionary into a compressed stream, where @signpdf's byte-level ByteRange
//    rewriting cannot find it.
//  - the appearance must be written BEFORE signing so it falls inside the
//    signed byte range. True by construction: it is embedded here.

import {
  PDFDocument,
  PDFArray,
  PDFDict,
  PDFName,
  PDFRef,
  type PDFPage,
} from '@cantoo/pdf-lib';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { SUBFILTER_ETSI_CADES_DETACHED, DEFAULT_SIGNATURE_LENGTH } from '@signpdf/utils';
import type { SignatureWidget } from '../templates';
import { widgetRectFits, widgetRectToPdf, type PdfRect } from './widget';

export interface PrepareSignatureOptions {
  /** Where the widget goes — the template's declared contract. */
  widget: SignatureWidget;
  /**
   * The stamp PDF from ./appearance.ts: one page, exactly the widget rect. Null
   * leaves @signpdf's empty appearance stream in place (an invisible field).
   */
  appearance: Uint8Array | null;
  /** Goes into /Name; the person the field records as signer. */
  name: string;
  reason: string;
  location: string;
  contactInfo: string;
  /**
   * Recorded as the signature dictionary's /M. PAdES baseline forbids a signed
   * signing-time ATTRIBUTE, so this entry is where the claimed time lives.
   */
  signingTime: Date;
  /**
   * Room reserved for the CMS, in HEX CHARACTERS — the unit @signpdf compares
   * against, since /Contents holds the CMS hex-encoded. So this is twice the
   * byte count, and passing a byte count reserves half of what is needed.
   *
   * The default is @signpdf's 8192, i.e. 4 KiB of CMS: enough for a 2048-bit
   * signer with a short chain and not enough for a qualified certificate.
   * `signPdf` measures the real figure instead (see ./index.ts) and always
   * passes it; the default is what remains for a direct caller.
   */
  signatureLength?: number;
}

export interface PreparedSignature {
  /** The prepared PDF: hand this to ./signer.ts, or download it as is. */
  bytes: Uint8Array;
  /** Zero-based index of the page the widget landed on (always the last one). */
  pageIndex: number;
  /** The widget rectangle in PDF coordinates, for assertions and debugging. */
  rect: PdfRect;
}

/** Read the page box pdfmake actually produced, cropbox-aware. */
function pageSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = page.getSize();
  return { width, height };
}

/**
 * Point the widget's appearance at the embedded stamp page, and drop the empty
 * stream @signpdf created for it.
 *
 * Kept to ONE flat form XObject: Acrobat has rejected the legacy n0/n2 layering
 * since version 6, and /Resources must be present on the stream even when it is
 * empty (an Acrobat quirk @signpdf already defends against on its own stream).
 */
function attachAppearance(doc: PDFDocument, widgetRef: PDFRef, appearanceRef: PDFRef): void {
  const widget = doc.context.lookup(widgetRef, PDFDict);
  const ap = widget.lookup(PDFName.of('AP'), PDFDict);
  const previous = ap.get(PDFName.of('N'));
  ap.set(PDFName.of('N'), appearanceRef);
  if (previous instanceof PDFRef) doc.context.delete(previous);

  const stream = doc.context.lookup(appearanceRef);
  const dict = stream instanceof PDFDict ? stream : (stream as { dict?: PDFDict }).dict;
  if (dict && !dict.get(PDFName.of('Resources'))) {
    dict.set(PDFName.of('Resources'), doc.context.obj({}));
  }
}

/** The widget @signpdf just appended — it is the last of the AcroForm fields. */
function lastFieldRef(doc: PDFDocument): PDFRef {
  const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
  const fields = acroForm.lookup(PDFName.of('Fields'), PDFArray);
  const ref = fields.get(fields.size() - 1);
  if (!(ref instanceof PDFRef)) {
    throw new Error('The signature placeholder did not register a widget field.');
  }
  return ref;
}

/**
 * Add the signature field, its visible appearance and the /Contents placeholder
 * to a rendered export.
 */
export async function prepareSignature(
  pdf: Blob | ArrayBuffer | Uint8Array,
  opts: PrepareSignatureOptions
): Promise<PreparedSignature> {
  const input =
    pdf instanceof Blob ? new Uint8Array(await pdf.arrayBuffer()) : new Uint8Array(pdf as ArrayBuffer);

  // updateMetadata:false keeps pdf-lib from stamping its own ModDate, so the
  // only difference from the unsigned export is the signature machinery.
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const pages = doc.getPages();
  if (pages.length === 0) throw new Error('Cannot sign an empty document.');

  // The contract says the last page, and the template guarantees it by pushing
  // its reserved block there (see ../templates.ts).
  const pageIndex = pages.length - 1;
  const page = pages[pageIndex];
  const size = pageSize(page);
  if (!widgetRectFits(opts.widget.rect, size)) {
    throw new Error(
      `The signature widget does not fit the last page (${size.width}×${size.height}pt).`
    );
  }
  const rect = widgetRectToPdf(opts.widget.rect, size.height);

  let appearanceRef: PDFRef | null = null;
  if (opts.appearance) {
    const [embedded] = await doc.embedPdf(opts.appearance);
    await embedded.embed();
    appearanceRef = embedded.ref;
  }

  pdflibAddPlaceholder({
    pdfDoc: doc,
    pdfPage: page,
    reason: opts.reason,
    contactInfo: opts.contactInfo,
    name: opts.name,
    location: opts.location,
    signingTime: opts.signingTime,
    signatureLength: opts.signatureLength ?? DEFAULT_SIGNATURE_LENGTH,
    subFilter: SUBFILTER_ETSI_CADES_DETACHED,
    widgetRect: rect,
  });

  if (appearanceRef) attachAppearance(doc, lastFieldRef(doc), appearanceRef);

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, pageIndex, rect };
}
