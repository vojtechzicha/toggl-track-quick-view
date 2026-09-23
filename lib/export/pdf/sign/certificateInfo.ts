// What a certificate says about itself, read from its DER.
//
// The Sign Bridge host reports certificates as raw DER only
// (docs/sign-bridge-plan.md). Subject, issuer, validity and the qualified claim
// are parsed here, with the ASN.1 stack the CMS already uses, so there is one
// implementation of "is this a QES" and check:signature can pin it.

import * as asn1js from 'asn1js';
import { AsnConvert, AsnParser } from '@peculiar/asn1-schema';
import {
  Certificate,
  KeyUsage,
  id_ce_keyUsage,
  id_ce_certificatePolicies,
} from '@peculiar/asn1-x509';

export interface CertificateInfo {
  subjectCN: string;
  issuerCN: string;
  notBeforeMs: number;
  notAfterMs: number;
  /**
   * The certificate claims to be qualified and on a qualified device, so a
   * signature made with it would be a QES. Only a validator checking the EU
   * Trust List can confirm it: false is reliable, true is an expectation.
   */
  qualified: boolean;
  /**
   * Key usage includes nonRepudiation (contentCommitment), which separates a
   * signing certificate from an authentication one. I.CA's TWINS product puts
   * both on the same card.
   */
  forSignature: boolean;
}

/**
 * A certificate's issuer and subject names as hex of their DER, for chain
 * building.
 *
 * Names are compared as encoded bytes rather than as printed strings, because
 * two names that print the same can differ in string type or ordering. Null
 * when the certificate does not parse.
 */
export function readCertificateNames(der: Uint8Array): { subject: string; issuer: string } | null {
  try {
    const certificate = AsnParser.parse(toArrayBuffer(der), Certificate);
    return {
      subject: hex(AsnConvert.serialize(certificate.tbsCertificate.subject)),
      issuer: hex(AsnConvert.serialize(certificate.tbsCertificate.issuer)),
    };
  } catch {
    return null;
  }
}

/**
 * Length in bytes of an RSASSA-PKCS1-v1_5 signature made with this
 * certificate's key, i.e. the modulus length.
 *
 * Used to size the CMS placeholder before signing (reserveForCms in
 * ./index.ts). Null when the key is not RSA or does not parse, so the caller
 * can fall back.
 */
export function rsaSignatureBytes(der: Uint8Array): number | null {
  try {
    const certificate = AsnParser.parse(toArrayBuffer(der), Certificate);
    const spki = certificate.tbsCertificate.subjectPublicKeyInfo;
    const parsed = asn1js.fromBER(spki.subjectPublicKey as ArrayBuffer);
    if (parsed.offset === -1) return null;
    // RSAPublicKey ::= SEQUENCE { modulus INTEGER, publicExponent INTEGER }
    const modulus = (parsed.result as unknown as { valueBlock?: { value?: asn1js.AsnType[] } })
      .valueBlock?.value?.[0];
    if (!(modulus instanceof asn1js.Integer)) return null;
    const bytes = new Uint8Array(modulus.valueBlock.valueHexView);
    // DER prefixes a positive INTEGER whose top bit is set with a zero byte,
    // which is not part of the modulus.
    return bytes[0] === 0x00 ? bytes.length - 1 : bytes.length;
  } catch {
    return null;
  }
}

const hex = (buffer: ArrayBuffer): string =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const toArrayBuffer = (der: Uint8Array): ArrayBuffer =>
  der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer;

/** ETSI EN 319 412-5 qcStatements, and the policies that mean "on a QSCD". */
const OID = {
  qcStatements: '1.3.6.1.5.5.7.1.3',
  /** esi4-qcStatement-1: this is a qualified certificate. */
  qcCompliance: '0.4.0.1862.1.1',
  /** esi4-qcStatement-4: its key lives on a qualified device. */
  qcSSCD: '0.4.0.1862.1.4',
  /** Policies that assert the same thing a different way. */
  qcpPublicWithSSCD: '0.4.0.1456.1.1',
  qcpNaturalQSCD: '0.4.0.194112.1.2',
  qcpLegalQSCD: '0.4.0.194112.1.3',
} as const;

const decodeCN = (name: unknown): string => {
  // Walks the RDNSequence instead of parsing a DN string, because CNs with
  // commas are common in Czech certificates ("CN=Zicha\, Vojtěch").
  const rdns = name as { map?: unknown[] } | undefined;
  const sequence = Array.isArray(rdns) ? rdns : (rdns?.map ?? []);
  for (const rdn of sequence as { type?: string; value?: unknown }[][]) {
    for (const attribute of rdn ?? []) {
      if (attribute?.type !== '2.5.4.3') continue;
      const value = attribute.value as
        | { toString(): string; utf8String?: string; printableString?: string }
        | undefined;
      const text = value?.utf8String ?? value?.printableString ?? value?.toString();
      if (text) return String(text);
    }
  }
  return '';
};

/**
 * Parse the fields the export dialog and the stamp need.
 *
 * Never throws. An unreadable certificate yields empty strings and `false`, so
 * one bad entry does not hide the rest of the list.
 */
export function readCertificateInfo(der: Uint8Array): CertificateInfo {
  const empty: CertificateInfo = {
    subjectCN: '',
    issuerCN: '',
    notBeforeMs: 0,
    notAfterMs: 0,
    qualified: false,
    forSignature: false,
  };

  let certificate: Certificate;
  try {
    certificate = AsnParser.parse(toArrayBuffer(der), Certificate);
  } catch {
    return empty;
  }

  const tbs = certificate.tbsCertificate;
  const time = (t: { utcTime?: Date; generalTime?: Date }): number =>
    (t.utcTime ?? t.generalTime)?.getTime() ?? 0;

  let qualified = false;
  let forSignature = false;

  for (const extension of tbs.extensions ?? []) {
    try {
      if (extension.extnID === id_ce_keyUsage) {
        const usage = AsnParser.parse(extension.extnValue.buffer as ArrayBuffer, KeyUsage);
        // By name, not by the library's numeric flag value.
        forSignature = usage.toJSON().includes('nonRepudiation');
      } else if (extension.extnID === OID.qcStatements || extension.extnID === id_ce_certificatePolicies) {
        // Either extension is enough to set the claim.
        qualified = qualified || claimsQualified(extension.extnID, extension.extnValue.buffer as ArrayBuffer);
      }
    } catch {
      // Skip an extension that does not parse; keep the others.
    }
  }

  return {
    subjectCN: decodeCN(tbs.subject),
    issuerCN: decodeCN(tbs.issuer),
    notBeforeMs: time(tbs.validity.notBefore),
    notAfterMs: time(tbs.validity.notAfter),
    qualified,
    forSignature,
  };
}

/**
 * Whether one extension asserts a qualified certificate on a qualified device.
 *
 * Both are required for a QES: a qualified certificate whose key is not on a
 * QSCD does not count.
 */
function claimsQualified(extnID: string, value: ArrayBuffer): boolean {
  const parsed = asn1js.fromBER(value);
  if (parsed.offset === -1) return false;

  const oids = collectOids(parsed.result);
  if (extnID === id_ce_certificatePolicies) {
    return (
      oids.has(OID.qcpPublicWithSSCD) || oids.has(OID.qcpNaturalQSCD) || oids.has(OID.qcpLegalQSCD)
    );
  }
  return oids.has(OID.qcCompliance) && oids.has(OID.qcSSCD);
}

/** Every OBJECT IDENTIFIER anywhere in a parsed structure. */
function collectOids(node: asn1js.AsnType, found = new Set<string>()): Set<string> {
  if (node instanceof asn1js.ObjectIdentifier) {
    found.add(node.getValue());
    return found;
  }
  const children = (node as unknown as { valueBlock?: { value?: asn1js.AsnType[] } }).valueBlock?.value;
  for (const child of children ?? []) collectOids(child, found);
  return found;
}
