// RFC 3161 timestamps: what turns a PAdES-B-B signature into a B-T one.
//
// The point is not decoration. A signature carries no trustworthy time of its
// own — the signature dictionary's /M entry is whatever the signing computer's
// clock said, which is why Acrobat reports "signing time is from the clock on
// the signer's computer". A qualified certificate is issued for a year, and
// once it expires a validator has no way to tell a signature made while it was
// valid from one made afterwards. A timestamp from a trusted third party is the
// evidence that fixes it: it says the signature existed at a time, and that time
// can be checked against the certificate's validity window forever.
//
// The token goes in as an UNSIGNED attribute, which is what makes it addable at
// all — it covers the signature value, so it cannot exist until after the card
// has signed, and it must not disturb the bytes the card put its name to.
//
// The request never goes to the TSA from here: public TSAs do not send CORS
// headers, and the address is server-side configuration rather than something a
// page gets to choose (see app/api/timestamp). This module talks to our own
// route and does all of the checking.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/** id-aa-signatureTimeStampToken — RFC 3161 §5, the unsigned attribute. */
export const SIGNATURE_TIMESTAMP_OID = '1.2.840.113549.1.9.16.2.14';

/** id-ct-TSTInfo — the eContent type inside the token. */
const TST_INFO_OID = '1.2.840.113549.1.9.16.1.4';

/** Where the proxy lives. Relative, so it follows the deployment. */
const TIMESTAMP_ENDPOINT = '/api/timestamp';

export interface TimestampOptions {
  /**
   * Sent as `x-app-auth`, because the route is gated the way the Toggl proxy
   * is: a timestamp may cost money, and an ungated one is a stranger's budget.
   */
  appAuth?: string | null;
  /** Overridable for the checks; nothing else should need it. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

/** Raised when a timestamp cannot be obtained or cannot be trusted. */
export class TimestampError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimestampError';
  }
}

const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * The bytes inside an OCTET STRING, whichever of the two legal encodings it is.
 *
 * BER allows a constructed OCTET STRING — the content split across nested
 * primitive pieces — and DER does not, but a TimeStampToken's eContent arrives
 * however its producer felt like emitting it. Most TSAs send a primitive one;
 * PKI.js itself emits a constructed one, so a reader that only handles the
 * primitive form falls over on tokens it generated. Reading only
 * `valueHexView` silently yields ZERO bytes on the constructed form, which
 * surfaces as "that is not a TSTInfo" rather than as an encoding difference.
 */
function octetsOf(content: asn1js.AsnType): Uint8Array {
  const block = content as unknown as {
    idBlock?: { isConstructed?: boolean };
    valueBlock: { valueHexView: Uint8Array; value?: asn1js.AsnType[] };
  };
  if (!block.idBlock?.isConstructed) return new Uint8Array(block.valueBlock.valueHexView);

  const pieces = (block.valueBlock.value ?? []).map((piece) => octetsOf(piece));
  const total = pieces.reduce((n, piece) => n + piece.length, 0);
  const joined = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    joined.set(piece, at);
    at += piece.length;
  }
  return joined;
}

/**
 * Ask the TSA to timestamp `signature`, and return the TimeStampToken's DER.
 *
 * The returned bytes are a ContentInfo — exactly what the unsigned attribute
 * carries, and what a validator will re-parse.
 */
export async function requestTimestamp(
  signature: Uint8Array,
  options: TimestampOptions = {}
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const imprint = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(signature))
  );

  // A nonce is the only thing that ties the answer to THIS request. Without one
  // a cached or replayed token from any past signature comes back looking
  // perfectly well-formed, and the resulting file claims a time it never had.
  const nonceBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  // Cleared so the INTEGER is unambiguously positive: a negative nonce is legal
  // ASN.1 and a needless way to differ from what a TSA echoes back.
  nonceBytes[0] &= 0x7f;
  const nonce = new asn1js.Integer({ valueHex: toArrayBuffer(nonceBytes) });

  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),
      hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(imprint) }),
    }),
    // Ask for the TSA's certificate. Without it the token names a signer that
    // the file does not contain, and a validator has to go and find it — the
    // same offline failure the certificate chain was embedded to avoid.
    certReq: true,
    nonce,
  });

  const body = new Uint8Array(request.toSchema().toBER(false));

  let response: Response;
  try {
    response = await fetchImpl(options.endpoint ?? TIMESTAMP_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/timestamp-query',
        ...(options.appAuth ? { 'x-app-auth': options.appAuth } : {}),
      },
      body: body as unknown as BodyInit,
    });
  } catch (e) {
    throw new TimestampError(
      `The timestamp authority could not be reached: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!response.ok) {
    // The route puts a sentence in the body; it is more useful than the status.
    const detail = await response.text().catch(() => '');
    throw new TimestampError(
      detail.slice(0, 300) || `The timestamp authority answered ${response.status}.`
    );
  }

  const raw = new Uint8Array(await response.arrayBuffer());
  return readToken(raw, imprint, nonceBytes);
}

/**
 * Parse a TimeStampResp and return its token — after checking that the token is
 * an answer to the question that was asked.
 *
 * Every check here is one that a well-formed but WRONG token would otherwise
 * pass. A timestamp nobody verified is a decoration: it would still parse, and
 * a validator downstream would be the first to notice, long after the signature
 * had been sent to a client.
 */
export function readToken(
  raw: Uint8Array,
  expectedImprint: Uint8Array,
  expectedNonce: Uint8Array
): Uint8Array {
  let timeStampResp: pkijs.TimeStampResp;
  try {
    const parsed = asn1js.fromBER(toArrayBuffer(raw));
    if (parsed.offset === -1) throw new Error('not DER');
    timeStampResp = new pkijs.TimeStampResp({ schema: parsed.result });
  } catch {
    throw new TimestampError('The timestamp authority sent something that is not a TimeStampResp.');
  }

  // PKIStatus: 0 granted, 1 grantedWithMods. Anything else is a refusal, and
  // the PKIFailureInfo beside it is the only explanation there will be.
  const status = timeStampResp.status.status;
  if (status !== 0 && status !== 1) {
    const text = timeStampResp.status.statusStrings?.map((s) => s.getValue()).join('; ');
    throw new TimestampError(
      `The timestamp authority refused the request (status ${status}${text ? `: ${text}` : ''}).`
    );
  }
  if (!timeStampResp.timeStampToken) {
    throw new TimestampError('The timestamp authority granted the request and sent no token.');
  }

  const token = timeStampResp.timeStampToken;
  const signedData = new pkijs.SignedData({ schema: token.content });
  const encap = signedData.encapContentInfo;
  if (encap.eContentType !== TST_INFO_OID) {
    throw new TimestampError('The token does not contain a TSTInfo.');
  }
  const eContent = encap.eContent;
  if (!eContent) throw new TimestampError('The token contains an empty TSTInfo.');

  let tstInfo: pkijs.TSTInfo;
  try {
    const inner = octetsOf(eContent);
    const parsed = asn1js.fromBER(toArrayBuffer(inner));
    if (parsed.offset === -1) throw new Error('not DER');
    tstInfo = new pkijs.TSTInfo({ schema: parsed.result });
  } catch {
    throw new TimestampError('The token\u2019s TSTInfo could not be read.');
  }

  // The imprint is the whole claim: it says WHICH bytes were timestamped. A
  // token over anything else is a true statement about someone else's data.
  const stamped = new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (!equalBytes(stamped, expectedImprint)) {
    throw new TimestampError('The token timestamps a different digest than the one sent.');
  }

  // RFC 3161 §2.4.2: when the request carried a nonce the response MUST echo
  // it. A token without one may be a replay of an older exchange.
  const echoed = tstInfo.nonce
    ? new Uint8Array(tstInfo.nonce.valueBlock.valueHexView)
    : null;
  if (!echoed) {
    throw new TimestampError('The token echoes no nonce, so it cannot be tied to this request.');
  }
  // Compared after stripping the leading zero DER adds to keep an INTEGER
  // positive: the value is what has to match, not its encoding.
  const strip = (b: Uint8Array) => (b.length > 1 && b[0] === 0x00 ? b.subarray(1) : b);
  if (!equalBytes(strip(echoed), strip(expectedNonce))) {
    throw new TimestampError('The token echoes a different nonce — it answers another request.');
  }

  return new Uint8Array(token.toSchema().toBER(false));
}

/**
 * Room to leave for a timestamp token that does not exist yet.
 *
 * The PDF reserves space for the CMS before anything is signed, and the token
 * cannot be fetched until after — it covers the signature. So the reservation
 * has to be an allowance rather than a measurement, and it is generous on
 * purpose: over-reserving costs zero-padding in a file that is already
 * hundreds of kilobytes, while under-reserving throws away a signature the card
 * has already made and the user has already entered a PIN for.
 *
 * 12 KiB against tokens that run 1.5–6 KiB — an RFC 3161 token is a SignedData
 * carrying the TSA's own certificate chain, so its size is the TSA's business
 * and not something to predict closely.
 */
export const TIMESTAMP_ALLOWANCE_BYTES = 12 * 1024;
