// Turn a finished export into a PDF with an empty, visible signature field.
//
// Nothing cryptographic happens here. The result is a valid PDF on its own and
// the input @signpdf needs: a /Contents placeholder large enough for the CMS
// and a /ByteRange for @signpdf to fill in.
//
//  - Saved with `useObjectStreams: false`. Object streams would put the
//    signature dictionary in a compressed stream, where @signpdf's byte-level
//    ByteRange rewriting cannot find it.
//  - The appearance is embedded here, before signing, so it falls inside the
//    signed byte range.

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
import type { SignatureWidget } from '../types';
import { widgetRectFits, widgetRectToPdf, type PdfRect } from './widget';

export interface PrepareSignatureOptions {
  /** Where the widget goes — the template's declared contract. */
  widget: SignatureWidget;
  /**
   * The stamp PDF from ./appearance.ts, one page the size of the widget rect.
   * Null leaves @signpdf's empty appearance stream (an invisible field).
   */
  appearance: Uint8Array | null;
  /** Written to /Name: the signer the field records. */
  name: string;
  reason: string;
  location: string;
  contactInfo: string;
  /**
   * Written to the signature dictionary's /M. PAdES baseline forbids a signed
   * signing-time attribute, so this is where the claimed time goes.
   */
  signingTime: Date;
  /**
   * Room reserved for the CMS, in hex characters (twice the byte count), since
   * /Contents holds the CMS hex-encoded.
   *
   * Defaults to @signpdf's 8192, i.e. 4 KiB of CMS, which is too small for a
   * qualified certificate with its chain. `signPdf` always passes a measured
   * value (./index.ts).
   */
  signatureLength?: number;
}

export interface PreparedSignature {
  /** The prepared PDF, ready for @signpdf and ./signer.ts. */
  bytes: Uint8Array;
  /** Zero-based index of the page the widget landed on (always the last one). */
  pageIndex: number;
  /** The widget rectangle in PDF coordinates, for assertions and debugging. */
  rect: PdfRect;
}

/** The page's MediaBox size, as pdfmake produced it. */
function pageSize(page: PDFPage): { width: number; height: number } {
  const { width, height } = page.getSize();
  return { width, height };
}

/**
 * Point the widget's appearance at the embedded stamp page and drop the empty
 * stream @signpdf created for it.
 *
 * One flat form XObject: Acrobat has rejected the legacy n0/n2 layering since
 * version 6. Acrobat also requires /Resources on the stream, even when empty.
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

  // updateMetadata: false stops pdf-lib from writing its own producer and
  // dates, so only the signature machinery differs from the unsigned export.
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const pages = doc.getPages();
  if (pages.length === 0) throw new Error('Cannot sign an empty document.');

  // The template guarantees the rect is free on the last page (SignatureWidget
  // in ../types.ts).
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
