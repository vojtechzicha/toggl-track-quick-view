// RFC 3161 timestamps, which turn a PAdES-B-B signature into B-T.
//
// The signature dictionary's /M is only the signing computer's clock. Once the
// certificate expires, a validator cannot tell whether a signature was made
// while it was valid. A timestamp from a trusted third party proves the
// signature existed at a given time.
//
// The token covers the signature value, so it is added after signing as an
// unsigned attribute (./cms.ts).
//
// Requests go to our own route (app/api/timestamp), not the TSA: public TSAs
// send no CORS headers, and the TSA address is server configuration. All
// checking of the response happens here.

import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/** id-aa-signatureTimeStampToken — RFC 3161 §5, the unsigned attribute. */
export const SIGNATURE_TIMESTAMP_OID = '1.2.840.113549.1.9.16.2.14';

/** id-ct-TSTInfo — the eContent type inside the token. */
const TST_INFO_OID = '1.2.840.113549.1.9.16.1.4';

const TIMESTAMP_ENDPOINT = '/api/timestamp';

export interface TimestampOptions {
  /**
   * Password-gate session token, sent as `x-app-auth`. The route is gated
   * because qualified timestamps cost money.
   */
  appAuth?: string | null;
  /** For the checks. */
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
 * The bytes inside an OCTET STRING, primitive or constructed.
 *
 * BER allows a constructed OCTET STRING (content split into nested pieces).
 * Most TSAs send a primitive one, but PKI.js emits a constructed one. On the
 * constructed form `valueHexView` is empty, which would surface as "not a
 * TSTInfo".
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
 * Ask the TSA to timestamp `signature` and return the TimeStampToken's DER (a
 * ContentInfo, as the unsigned attribute carries it).
 */
export async function requestTimestamp(
  signature: Uint8Array,
  options: TimestampOptions = {}
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const imprint = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', toArrayBuffer(signature))
  );

  // The nonce ties the answer to this request; without it a cached or
  // replayed token would look valid.
  const nonceBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  // Keep the INTEGER positive so it matches what the TSA echoes.
  nonceBytes[0] &= 0x7f;
  const nonce = new asn1js.Integer({ valueHex: toArrayBuffer(nonceBytes) });

  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: '2.16.840.1.101.3.4.2.1' }),
      hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(imprint) }),
    }),
    // Include the TSA's certificate in the token, so a validator does not have
    // to fetch it.
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
    // The route explains the failure in the body.
    const detail = await response.text().catch(() => '');
    throw new TimestampError(
      detail.slice(0, 300) || `The timestamp authority answered ${response.status}.`
    );
  }

  const raw = new Uint8Array(await response.arrayBuffer());
  return readToken(raw, imprint, nonceBytes);
}

/**
 * Parse a TimeStampResp and return its token after checking that it answers
 * this request. A well-formed token over the wrong data parses just as cleanly
 * as a correct one, so each check below catches a case the parser would not.
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

  // PKIStatus: 0 granted, 1 grantedWithMods. Anything else is a refusal.
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

  // The imprint says which bytes were timestamped.
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
  // Compare values, ignoring the leading zero DER may add to keep an INTEGER
  // positive.
  const strip = (b: Uint8Array) => (b.length > 1 && b[0] === 0x00 ? b.subarray(1) : b);
  if (!equalBytes(strip(echoed), strip(expectedNonce))) {
    throw new TimestampError('The token echoes a different nonce — it answers another request.');
  }

  return new Uint8Array(token.toSchema().toBER(false));
}

/**
 * Room reserved in the CMS placeholder for a timestamp token.
 *
 * The placeholder is sized before signing and the token only exists after, so
 * this is an allowance, not a measurement. Tokens run 1.5–6 KiB, depending on
 * the TSA's certificate chain. Over-reserving costs zero padding;
 * under-reserving fails the export after the card has signed.
 */
export const TIMESTAMP_ALLOWANCE_BYTES = 12 * 1024;
