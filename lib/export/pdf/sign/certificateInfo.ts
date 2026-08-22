// What a certificate says about itself, read from its DER.
//
// The Sign Bridge helper reports certificates as raw DER and nothing derived
// from it — see ../../../../docs/sign-bridge-plan.md. Subject, issuer, validity
// and, above all, whether the certificate claims to be a qualified one are all
// decided here instead, for one reason: this repository already carries an
// ASN.1 stack to build the CMS, and a second implementation in Swift could
// disagree with this one. A disagreement about "is this a QES" that only shows
// up in a validator is the exact failure the picker exists to prevent.

import * as asn1js from 'asn1js';
import { AsnParser } from '@peculiar/asn1-schema';
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
   * The certificate claims to be a qualified certificate on a qualified device
   * — i.e. a signature made with it is a QES.
   *
   * A claim, not a verdict: it is what the certificate says about itself, and
   * only a validator checking the EU Trust List can say whether that is true.
   * So false is reliable and true is an expectation, which is the right way
   * round for warning someone before they sign.
   */
  qualified: boolean;
  /**
   * Key usage includes nonRepudiation (contentCommitment) — the bit separating
   * a signing certificate from an authentication one. I.CA's TWINS product
   * issues both to the same person on the same card.
   */
  forSignature: boolean;
}

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
  // The RDNSequence is walked rather than stringified: a CN containing a comma
  // is routine in Czech certificates ("CN=Zicha\, Vojtěch"), and every
  // string-first approach has to un-escape what it just escaped.
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
 * Never throws: a certificate this cannot read is still one the token may be
 * able to sign with, and the honest answer is empty strings and `false` rather
 * than an error that hides the whole list.
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
    certificate = AsnParser.parse(
      der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength) as ArrayBuffer,
      Certificate
    );
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
        // By name rather than by bit: the flag's numeric value is an
        // implementation detail of the library, the name is what X.509 fixes.
        forSignature = usage.toJSON().includes('nonRepudiation');
      } else if (extension.extnID === OID.qcStatements || extension.extnID === id_ce_certificatePolicies) {
        // Both extensions are read for the same conclusion, so whichever
        // arrives first can set it and the other can only confirm.
        qualified = qualified || claimsQualified(extension.extnID, extension.extnValue.buffer as ArrayBuffer);
      }
    } catch {
      // An extension that will not parse says nothing; it must not lose the
      // ones that did.
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
 * Both halves are required — "qualified certificate" alone is not a QES; the
 * key must also be on a QSCD, which is what separates a certificate on a card
 * from a soft one issued under the same policy.
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
