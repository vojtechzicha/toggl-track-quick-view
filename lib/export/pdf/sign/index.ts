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
   * Nothing in the PDF depends on it.
   */
  documentName?: string;
  /**
   * Ask the configured timestamp authority for an RFC 3161 token, producing
   * PAdES-B-T instead of B-B. Off when absent.
   *
   * Worth having because a certificate is issued for a year: without a
   * timestamp, a validator cannot tell a signature made while the certificate
   * was valid from one made after it expired, and every signature quietly stops
   * verifying on the renewal date.
   */
  timestamp?: TimestampOptions | false;
  /** Told which level actually came out, and why, when a timestamp was asked for. */
  onLevel?: (level: 'B-B' | 'B-T', timestampError: Error | null) => void;
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

/**
 * Bytes to reserve in /Contents for the CMS, measured rather than guessed.
 *
 * The PDF must reserve the room before anything is signed, and @signpdf's 8 KiB
 * default is sized for a 2048-bit signer with no chain. A real qualified
 * certificate is not that: an RSA-4096 signer certificate, its issuing CA and a
 * 512-byte signature come to over 10 KiB, and the export fails at the last step
 * with "signature exceeds placeholder length" — after the PIN has been typed and
 * the signature has already been made on the card.
 *
 * A constant large enough for every case would waste a fixed amount of every
 * PDF and still be a guess. This builds the CMS instead, over a zero digest and
 * a zero signature, and measures it. That is exact: a CMS's DER length is
 * decided by the SIZES of the certificate, the chain and the signature, and by
 * nothing about the values — the digest is always 32 bytes and an RSA signature
 * is always the modulus length, whatever they contain.
 */
async function reserveForCms(
  certificate: Uint8Array,
  chain: Uint8Array[],
  timestamped: boolean
): Promise<number> {
  // Falls back to 4096-bit rather than to the smallest plausible key: over-
  // reserving costs bytes in the file, under-reserving costs a signature.
  const signatureBytes = rsaSignatureBytes(certificate) ?? 512;
  const probe = await buildCms({
    certificate,
    chain,
    messageDigest: new Uint8Array(32),
    sign: async () => new Uint8Array(signatureBytes),
  });
  // The timestamp cannot be measured the same way — it does not exist until the
  // signature does, and asking a TSA for one just to size the hole would spend
  // a stamp to learn how big a stamp is. So it gets an allowance instead, and a
  // generous one; see TIMESTAMP_ALLOWANCE_BYTES for why erring large is free
  // and erring small is not.
  const allowance = timestamped ? TIMESTAMP_ALLOWANCE_BYTES : 0;

  // Margin for the ASN.1 length prefixes, which grow by a byte as the structure
  // crosses 256, 65536 … and for the leading zero DER adds to a positive
  // INTEGER whose top bit happens to be set in the real signature but not in a
  // probe full of zeros.
  //
  // Doubled because the placeholder is counted in HEX CHARACTERS, not bytes:
  // /Contents holds the CMS hex-encoded, and @signpdf compares its length
  // against this number directly. Returning a byte count here reserves half of
  // what is needed and fails at the same last step it was meant to prevent.
  return (probe.length + allowance + 512) * 2;
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

  // The issuing chain is fetched here rather than when the certificate was
  // listed: a bridge over a software key store can list dozens, and only the
  // one being signed with is worth a round trip. A bridge that has no chain to
  // offer simply ships without one.
  //
  // It is fetched BEFORE the placeholder is written, because how much room the
  // placeholder needs depends on how many certificates end up inside it.
  const chain = options.certificate.chain.length
    ? options.certificate.chain
    : (await options.bridge.certificateChain?.(options.certificate.id)) ?? [];

  const stamp = await renderAppearance(options.widget.rect, appearance);
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
