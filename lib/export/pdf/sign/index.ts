// Entry point of the optional signing stage (docs/pdf-signing-v2.md).
//
// Runs after toPDF() has finished and never changes an unsigned export:
//
//   toPDF() Blob
//     → renderAppearance()   the visible block, authored with pdfmake
//     → prepareSignature()   signature field + widget + /Contents placeholder
//     → PadesSigner          SHA-256 over the byte range → CMS via the bridge
//     → signed PDF Blob
//
// Loaded only by dynamic import (lib/export/index.ts), so @signpdf, PKI.js and
// pdf-lib stay out of the main bundle.

import type { PdfFontPack, SignatureWidget } from '../types';
import { renderAppearance } from './appearance';
import { rsaSignatureBytes } from './certificateInfo';
import { buildCms } from './cms';
import { prepareSignature } from './prepare';
import { PadesSigner } from './signer';
import { requestTimestamp, TIMESTAMP_ALLOWANCE_BYTES, type TimestampOptions } from './timestamp';
import type { TokenBridge, TokenCertificate } from './tokenBridge';
import type { SignatureAppearance } from './types';

export { prepareSignature, type PreparedSignature } from './prepare';
export { renderAppearance, appearanceDocDefinition } from './appearance';
export { buildCms, sha256, PADES_SIGNED_ATTRIBUTE_OIDS } from './cms';
export { widgetRectToPdf, widgetRectFits, type PdfRect } from './widget';
export {
  requestTimestamp,
  readToken,
  TimestampError,
  SIGNATURE_TIMESTAMP_OID,
  TIMESTAMP_ALLOWANCE_BYTES,
  type TimestampOptions,
} from './timestamp';
export {
  WebCryptoBridge,
  ExtensionBridge,
  SIGN_BRIDGE_EXTENSION_ID,
  TokenBridgeUnavailableError,
  availableBridges,
  type AvailableBridgeOptions,
  type ExtensionBridgeOptions,
  type BridgeReadiness,
  type TokenBridge,
  type TokenCertificate,
  type SignDigestRequest,
} from './bridge';
export { ensureCryptoEngine, generateThrowawayKey, type ThrowawayKey } from './throwaway';
export { PadesSigner } from './signer';
export {
  DEFAULT_SIGNATURE_APPEARANCE,
  SIGNATURE_STRINGS,
  STAMP_STYLE,
  formatSignedAt,
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
  /**
   * The export's filename, shown by a bridge that confirms before it signs.
   * Not written into the PDF.
   */
  documentName?: string;
  /**
   * The template's font loader, so the stamp uses the same fonts as the page.
   * Omitted renders it in pdfmake's Roboto, which is what a template without
   * embedded fonts uses anyway.
   */
  loadFonts?: () => Promise<PdfFontPack>;
  /**
   * Request an RFC 3161 token from the configured TSA, producing PAdES-B-T
   * instead of B-B. Without one, the signature stops verifying when the
   * certificate expires.
   */
  timestamp?: TimestampOptions | false;
  /** Reports the level produced, and the timestamp error if B-T was asked for and failed. */
  onLevel?: (level: 'B-B' | 'B-T', timestampError: Error | null) => void;
}

/**
 * @signpdf needs Buffer, which browsers lack. Installed here, in the lazily
 * loaded stage, so unsigned exports never load the polyfill.
 */
async function ensureBuffer(): Promise<void> {
  if (typeof globalThis.Buffer === 'undefined') {
    const { Buffer } = await import('buffer');
    (globalThis as unknown as { Buffer: unknown }).Buffer = Buffer;
  }
}

/**
 * Room to reserve in /Contents for the CMS, in hex characters.
 *
 * The room must be reserved before signing. @signpdf's default (4 KiB of CMS)
 * fits a 2048-bit signer with no chain, but an RSA-4096 certificate, its
 * issuing CA and a 512-byte signature need more, and running out fails the
 * export after the card has already signed.
 *
 * So this builds the CMS over a zero digest and a zero signature and measures
 * it. A CMS's DER length depends only on the sizes of the certificate, chain
 * and signature, not their values: the digest is always 32 bytes and an RSA
 * signature is always the modulus length.
 */
async function reserveForCms(
  certificate: Uint8Array,
  chain: Uint8Array[],
  timestamped: boolean
): Promise<number> {
  // Unknown key size: assume 4096-bit. Over-reserving only costs file size.
  const signatureBytes = rsaSignatureBytes(certificate) ?? 512;
  const probe = await buildCms({
    certificate,
    chain,
    messageDigest: new Uint8Array(32),
    sign: async () => new Uint8Array(signatureBytes),
  });
  // The timestamp token cannot be measured before it exists, so it gets a
  // fixed allowance (see TIMESTAMP_ALLOWANCE_BYTES).
  const allowance = timestamped ? TIMESTAMP_ALLOWANCE_BYTES : 0;

  // The 512-byte margin covers ASN.1 length prefixes that grow at 256, 65536…,
  // and the leading zero DER adds to a positive INTEGER whose top bit is set in
  // the real signature but not in the all-zero probe.
  //
  // Doubled because @signpdf counts the placeholder in hex characters:
  // /Contents holds the CMS hex-encoded.
  return (probe.length + allowance + 512) * 2;
}

/** Sign a rendered export. Returns a PAdES-B-B PDF, or B-T when timestamped. */
export async function signPdf(pdf: Blob, options: SignPdfOptions): Promise<Blob> {
  await ensureBuffer();
  const { SignPdf } = await import('@signpdf/signpdf');

  // One clock for the visible date and /M, read before the slow PIN-prompting
  // work starts.
  const signedAtMs = options.appearance.signedAtMs || Date.now();
  const appearance: SignatureAppearance = {
    ...options.appearance,
    signedAtMs,
    certificateCN: options.appearance.certificateCN || options.certificate.subjectCN,
  };

  // Fetched for the chosen certificate only, and before the placeholder is
  // written, because the chain's size decides how much room to reserve.
  const chain = options.certificate.chain.length
    ? options.certificate.chain
    : (await options.bridge.certificateChain?.(options.certificate.id)) ?? [];

  const stamp = await renderAppearance(options.widget, appearance, options.loadFonts);
  const prepared = await prepareSignature(pdf, {
    widget: options.widget,
    appearance: new Uint8Array(await stamp.arrayBuffer()),
    name: appearance.signerName || options.certificate.subjectCN,
    reason: options.reason ?? appearance.reason,
    location: options.location ?? '',
    contactInfo: options.contactInfo ?? '',
    signingTime: new Date(signedAtMs),
    signatureLength: await reserveForCms(options.certificate.der, chain, !!options.timestamp),
  });

  const timestampOptions = options.timestamp;
  const signer = new PadesSigner({
    bridge: options.bridge,
    certificateId: options.certificate.id,
    certificate: options.certificate.der,
    chain,
    documentName: options.documentName,
    timestamp: timestampOptions
      ? (signature) => requestTimestamp(signature, timestampOptions)
      : undefined,
    onLevel: options.onLevel,
  });
  const signed = await new SignPdf().sign(Buffer.from(prepared.bytes), signer);
  return new Blob([new Uint8Array(signed)], { type: 'application/pdf' });
}
