// A self-signed RSA key and certificate, generated in the browser (or in node,
// for the checks) and never persisted.
//
// This is the stand-in for the qualified certificate while the hardware token
// is in the post: it makes the whole pipeline — placeholder, appearance, CMS,
// embed — runnable and verifiable end to end today. A signature made with it is
// cryptographically sound and completely untrusted, which is precisely what a
// validator should say about it. The certificate is named accordingly so it can
// never be mistaken for the real one in a viewer.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

export interface ThrowawayKey {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  certificateDer: Uint8Array;
  subjectCN: string;
  notBeforeMs: number;
  notAfterMs: number;
}

export interface ThrowawayKeyOptions {
  commonName?: string;
  organization?: string;
  country?: string;
  notBeforeMs?: number;
  notAfterMs?: number;
  serialNumber?: Uint8Array;
  /**
   * Pre-generated key pair. The checks pass a fixed one so a regenerated
   * fixture is byte-identical; the app always generates a fresh one.
   */
  keyPair?: CryptoKeyPair;
}

const DEFAULT_CN = 'Throwaway Test Signer (NOT a qualified certificate)';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const RSA_PARAMS: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
};

/** PKI.js needs an explicit engine outside the browser's default wiring. */
export function ensureCryptoEngine(): void {
  const crypto = globalThis.crypto;
  if (!crypto?.subtle) {
    throw new Error('WebCrypto is unavailable — the signing pipeline needs crypto.subtle.');
  }
  const engine = pkijs.getEngine();
  if (!(engine?.crypto as { subtle?: unknown } | undefined)?.subtle) {
    pkijs.setEngine('tqv', new pkijs.CryptoEngine({ name: 'tqv', crypto }));
  }
}

/**
 * RFC 5280 §4.1.2.2: a certificate serial number MUST be a positive integer.
 * Random bytes are negative half the time (two's complement), and a negative
 * serial is the kind of thing a strict validator rejects long after the code
 * that produced it has been forgotten.
 */
function positiveSerial(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes);
  out[0] &= 0x7f;
  if (out.every((b) => b === 0)) out[out.length - 1] = 1;
  return out;
}

const typeAndValue = (type: string, value: string) =>
  new pkijs.AttributeTypeAndValue({ type, value: new asn1js.Utf8String({ value }) });

/** Generate the key and its self-signed certificate. */
export async function generateThrowawayKey(
  options: ThrowawayKeyOptions = {}
): Promise<ThrowawayKey> {
  ensureCryptoEngine();

  const commonName = options.commonName ?? DEFAULT_CN;
  const notBeforeMs = options.notBeforeMs ?? Date.now() - 60 * 60 * 1000;
  const notAfterMs = options.notAfterMs ?? notBeforeMs + YEAR_MS;

  const keyPair =
    options.keyPair ??
    ((await globalThis.crypto.subtle.generateKey(RSA_PARAMS, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair);

  const certificate = new pkijs.Certificate();
  certificate.version = 2; // X.509 v3
  certificate.serialNumber = new asn1js.Integer({
    valueHex: positiveSerial(
      options.serialNumber ?? globalThis.crypto.getRandomValues(new Uint8Array(8))
    ).buffer as ArrayBuffer,
  });

  const name = [typeAndValue('2.5.4.3', commonName)];
  if (options.organization) name.push(typeAndValue('2.5.4.10', options.organization));
  if (options.country) {
    name.push(
      new pkijs.AttributeTypeAndValue({
        type: '2.5.4.6',
        value: new asn1js.PrintableString({ value: options.country }),
      })
    );
  }
  // Self-signed: issuer and subject are the same name.
  certificate.issuer.typesAndValues.push(...name);
  certificate.subject.typesAndValues.push(...name);
  certificate.notBefore.value = new Date(notBeforeMs);
  certificate.notAfter.value = new Date(notAfterMs);

  certificate.extensions = [
    // Basic constraints: an end-entity certificate, not a CA.
    new pkijs.Extension({
      extnID: '2.5.29.19',
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: false }).toSchema().toBER(false),
    }),
    // Key usage: digitalSignature | nonRepudiation — what a signing
    // certificate carries, and what validators look for on a PAdES signer.
    new pkijs.Extension({
      extnID: '2.5.29.15',
      critical: true,
      extnValue: new asn1js.BitString({
        valueHex: new Uint8Array([0xc0]).buffer as ArrayBuffer,
        unusedBits: 6,
      }).toBER(false),
    }),
  ];

  await certificate.subjectPublicKeyInfo.importKey(keyPair.publicKey);
  await certificate.sign(keyPair.privateKey, 'SHA-256');

  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    certificateDer: new Uint8Array(certificate.toSchema(true).toBER(false)),
    subjectCN: commonName,
    notBeforeMs,
    notAfterMs,
  };
}
