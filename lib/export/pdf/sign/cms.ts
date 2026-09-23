// The PAdES CMS: a detached SignedData with exactly the signed attributes a
// baseline profile allows.
//
// Built on PKI.js instead of @signpdf/signer-p12, which adds a signed
// signing-time attribute. ETSI EN 319 142-1 forbids that in the baseline
// profiles, and validators then report the signature as "not PAdES" rather
// than invalid. The claimed time goes in the signature dictionary's /M
// (./prepare.ts).
//
// Signed attributes:
//
//   content-type            id-data
//   message-digest          SHA-256 over the PDF's signed byte range
//   signing-certificate-v2  SHA-256 over the signer's certificate
//
// The B-T timestamp is an unsigned attribute: it covers the signature value, so
// it can only be obtained after signing.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { SIGNATURE_TIMESTAMP_OID } from './timestamp';
import { AsnConvert, OctetString } from '@peculiar/asn1-schema';
import { ESSCertIDv2, IssuerSerial, SigningCertificateV2 } from '@peculiar/asn1-ess';
import { Certificate as AsnCertificate, GeneralName, GeneralNames } from '@peculiar/asn1-x509';

const OID = {
  signedData: '1.2.840.113549.1.7.2',
  data: '1.2.840.113549.1.7.1',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
} as const;

/** The exact set of signed attributes a PAdES baseline signature may carry. */
export const PADES_SIGNED_ATTRIBUTE_OIDS: readonly string[] = [
  OID.contentType,
  OID.messageDigest,
  OID.signingCertificateV2,
];

export interface BuildCmsInput {
  /** DER of the signing certificate. */
  certificate: Uint8Array;
  /** DER of the rest of the chain, leaf-first. May be empty. */
  chain: Uint8Array[];
  /** SHA-256 over the PDF's signed byte range. */
  messageDigest: Uint8Array;
  /**
   * Produce an RSASSA-PKCS1-v1_5 signature over SHA-256 of the given bytes
   * (the DER SignedAttributes). This is where the bridge signs; see
   * ./tokenBridge.ts.
   */
  sign: (toBeSigned: Uint8Array) => Promise<Uint8Array>;
  /**
   * Fetch an RFC 3161 token over the signature value, making the signature
   * PAdES-B-T. Omitted leaves it at B-B.
   *
   * A callback because the signature value only exists partway through this
   * function. Returning null yields B-B: by the time this runs the card has
   * signed, so the caller (./signer.ts) decides whether a missing timestamp is
   * fatal.
   */
  timestamp?: (signature: Uint8Array) => Promise<Uint8Array | null>;
}

const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

const parseAsn1 = (der: Uint8Array): asn1js.AsnType => {
  const parsed = asn1js.fromBER(toArrayBuffer(der));
  if (parsed.offset === -1) throw new Error(`Malformed DER: ${parsed.result.error}`);
  return parsed.result;
};

/**
 * X.690 §11.6: the components of a SET OF are sorted in ascending order of
 * their encodings, an octet at a time, and a value that is a prefix of another
 * sorts first. Only strict validators check this.
 */
function derSetOfOrder(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/** SHA-256 through whichever WebCrypto the runtime offers (browser and node). */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(data));
  return new Uint8Array(digest);
}

/**
 * IssuerSerial that encodes a real certificate serial number.
 *
 * @peculiar/asn1-ess declares `serialNumber` as a bare AsnPropTypes.Integer,
 * whose converter encodes through `+value`. Serials arrive from
 * @peculiar/asn1-x509 as raw INTEGER content octets (up to 20 bytes, RFC 5280),
 * and `+arrayBuffer` is NaN, so the attribute would carry serial 0 and pyHanko
 * and DSS reject the signature.
 *
 * The library's serializer prefers a value's own toASN() over the declared
 * schema, so only this field is encoded by hand.
 */
class PadesIssuerSerial extends IssuerSerial {
  constructor(issuer: GeneralNames, serialNumber: ArrayBuffer) {
    super();
    this.issuer = issuer;
    this.serialNumber = serialNumber;
  }

  toASN(): asn1js.Sequence {
    return new asn1js.Sequence({
      value: [
        parseAsn1(new Uint8Array(AsnConvert.serialize(this.issuer))),
        new asn1js.Integer({ valueHex: this.serialNumber }),
      ],
    });
  }

  /** Required for the serializer to recognise the override; never parsed back. */
  fromASN(): never {
    throw new Error('PadesIssuerSerial is write-only.');
  }
}

/**
 * signing-certificate-v2 for the signer, hashed with SHA-256.
 *
 *   SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }
 *   ESSCertIDv2 ::= SEQUENCE {
 *     hashAlgorithm  AlgorithmIdentifier DEFAULT id-sha256,
 *     certHash       OCTET STRING,
 *     issuerSerial   IssuerSerial OPTIONAL }
 */
async function signingCertificateV2(certificateDer: Uint8Array): Promise<Uint8Array> {
  const parsed = AsnConvert.parse(toArrayBuffer(certificateDer), AsnCertificate);
  const essCertId = new ESSCertIDv2({
    // hashAlgorithm is left unset: it DEFAULTs to id-sha256, and DER requires a
    // value equal to the default to be omitted.
    certHash: new OctetString(toArrayBuffer(await sha256(certificateDer))),
    issuerSerial: new PadesIssuerSerial(
      new GeneralNames([new GeneralName({ directoryName: parsed.tbsCertificate.issuer })]),
      parsed.tbsCertificate.serialNumber
    ),
  });
  return new Uint8Array(AsnConvert.serialize(new SigningCertificateV2({ certs: [essCertId] })));
}

/**
 * Assemble the detached CMS SignedData for a prepared PDF. Returns the DER of
 * the ContentInfo, which goes into the signature dictionary's /Contents.
 */
export async function buildCms(input: BuildCmsInput): Promise<Uint8Array> {
  const signerCert = new pkijs.Certificate({ schema: parseAsn1(input.certificate) });
  const chainCerts = input.chain.map(
    (der) => new pkijs.Certificate({ schema: parseAsn1(der) })
  );

  // RFC 5754: SHA-2 algorithm identifiers omit their parameters. rsaEncryption
  // (RFC 3370) is the opposite — its parameters MUST be present and NULL.
  const sha256Algorithm = new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 });

  const attributes = [
    new pkijs.Attribute({
      type: OID.contentType,
      values: [new asn1js.ObjectIdentifier({ value: OID.data })],
    }),
    new pkijs.Attribute({
      type: OID.messageDigest,
      values: [new asn1js.OctetString({ valueHex: toArrayBuffer(input.messageDigest) })],
    }),
    new pkijs.Attribute({
      type: OID.signingCertificateV2,
      values: [parseAsn1(await signingCertificateV2(input.certificate))],
    }),
  ];

  // Use the same order for the signed bytes and the shipped attributes: a
  // verifier re-encodes the attributes in the order it receives them.
  const sorted = attributes
    .map((attribute) => ({ attribute, der: new Uint8Array(attribute.toSchema().toBER(false)) }))
    .sort((a, b) => derSetOfOrder(a.der, b.der));

  // RFC 5652 §5.4: the signature is computed over the DER of SignedAttrs with
  // an explicit SET OF tag — not over the [0] IMPLICIT form that is stored.
  const toBeSigned = new Uint8Array(
    new asn1js.Set({ value: sorted.map((s) => s.attribute.toSchema()) }).toBER(false)
  );
  const signature = await input.sign(toBeSigned);

  // PAdES-B-T: an RFC 3161 token over the signature value, stored as the
  // unsigned attribute id-aa-signatureTimeStampToken so the signed bytes above
  // are unchanged.
  const timestampToken = input.timestamp ? await input.timestamp(signature) : null;

  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({
      issuer: signerCert.issuer,
      serialNumber: signerCert.serialNumber,
    }),
    digestAlgorithm: sha256Algorithm,
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({
      type: 0,
      attributes: sorted.map((s) => s.attribute),
    }),
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: OID.rsaEncryption,
      algorithmParams: new asn1js.Null(),
    }),
    signature: new asn1js.OctetString({ valueHex: toArrayBuffer(signature) }),
    ...(timestampToken
      ? {
          unsignedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 1,
            attributes: [
              new pkijs.Attribute({
                type: SIGNATURE_TIMESTAMP_OID,
                values: [parseAsn1(timestampToken)],
              }),
            ],
          }),
        }
      : {}),
  });

  const signedData = new pkijs.SignedData({
    version: 1,
    digestAlgorithms: [sha256Algorithm],
    // Detached: the eContent is the PDF's byte range, which is not carried here.
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    certificates: [signerCert, ...chainCerts],
    signerInfos: [signerInfo],
  });

  const contentInfo = new pkijs.ContentInfo({
    contentType: OID.signedData,
    content: signedData.toSchema(true),
  });
  return new Uint8Array(contentInfo.toSchema().toBER(false));
}
