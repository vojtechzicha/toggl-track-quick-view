// Entry point of the optional signing stage.
//
// Everything here runs AFTER toPDF() has finished: the pipeline takes a
// rendered export and returns a signed one, and there is no path by which it
// changes an unsigned export. That is the design rule from
// docs/pdf-signing-v2.md — signing is optional and additive — and it is what
// makes the whole feature safe to ship half-finished.
//
//   toPDF() Blob
//     → renderAppearance()   the visible block, authored with pdfmake
//     → prepareSignature()   signature field + widget + /Contents placeholder
//     → PadesSigner          SHA-256 over the byte range → CMS via the bridge
//     → signed PDF Blob
//
// This module is only ever reached through a dynamic import (see
// lib/export/index.ts), so @signpdf, PKI.js and pdf-lib stay out of the bundle
// of anyone who never signs anything.

import type { SignatureWidget } from '../templates';
import { renderAppearance } from './appearance';
import { prepareSignature } from './prepare';
import { PadesSigner } from './signer';
import type { TokenBridge, TokenCertificate } from './bridge';
import type { SignatureAppearance } from './types';

export { prepareSignature, type PreparedSignature } from './prepare';
export { renderAppearance, appearanceDocDefinition, formatSignedAt } from './appearance';
export { buildCms, sha256, PADES_SIGNED_ATTRIBUTE_OIDS } from './cms';
export { widgetRectToPdf, widgetRectFits, type PdfRect } from './widget';
export {
  WebCryptoBridge,
  FortifyBridge,
  TokenBridgeUnavailableError,
  availableBridges,
  type TokenBridge,
  type TokenCertificate,
  type SignDigestRequest,
} from './bridge';
export { generateThrowawayKey, type ThrowawayKey } from './throwaway';
export { PadesSigner } from './signer';
export {
  DEFAULT_SIGNATURE_APPEARANCE,
  SIGNATURE_STRINGS,
  type SignatureAppearance,
  type SignatureLayout,
  type SignatureLocale,
} from './types';

export interface SignPdfOptions {
  widget: SignatureWidget;
  appearance: SignatureAppearance;
  bridge: TokenBridge;
  certificate: TokenCertificate;
  /** Copied to /Reason, /Location and /ContactInfo in the signature dictionary. */
  reason?: string;
  location?: string;
  contactInfo?: string;
}

/**
 * @signpdf works in Buffers, which the browser does not have. The polyfill is
 * installed here — inside the lazily imported signing stage — rather than in the
 * app shell, so an export that is never signed never pays for it.
 */
async function ensureBuffer(): Promise<void> {
  if (typeof globalThis.Buffer === 'undefined') {
    const { Buffer } = await import('buffer');
    (globalThis as unknown as { Buffer: unknown }).Buffer = Buffer;
  }
}

/** Sign a rendered export. The returned Blob is a PAdES-B-B PDF. */
export async function signPdf(pdf: Blob, options: SignPdfOptions): Promise<Blob> {
  await ensureBuffer();
  const { SignPdf } = await import('@signpdf/signpdf');

  // One clock for the visible date and the /M entry, taken before any of the
  // (slow, PIN-prompting) work starts.
  const signedAtMs = options.appearance.signedAtMs || Date.now();
  const appearance: SignatureAppearance = {
    ...options.appearance,
    signedAtMs,
    certificateCN: options.appearance.certificateCN || options.certificate.subjectCN,
  };

  const stamp = await renderAppearance(options.widget.rect, appearance);
  const prepared = await prepareSignature(pdf, {
    widget: options.widget,
    appearance: new Uint8Array(await stamp.arrayBuffer()),
    name: appearance.signerName || options.certificate.subjectCN,
    reason: options.reason ?? appearance.reason,
    location: options.location ?? '',
    contactInfo: options.contactInfo ?? '',
    signingTime: new Date(signedAtMs),
  });

  const signer = new PadesSigner({
    bridge: options.bridge,
    certificateId: options.certificate.id,
    certificate: options.certificate.der,
    chain: options.certificate.chain,
  });
  const signed = await new SignPdf().sign(Buffer.from(prepared.bytes), signer);
  return new Blob([new Uint8Array(signed)], { type: 'application/pdf' });
}
