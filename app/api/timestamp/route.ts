// Same-origin proxy for an RFC 3161 timestamp authority. Browsers cannot POST
// to a TSA directly because public TSAs send no CORS headers.
//
//  - The destination comes from TSA_URL only. Taking a URL from the request
//    would be an SSRF hole.
//  - Gated like the Toggl proxy, because qualified timestamps cost money.
//  - The body is capped, so the route cannot relay arbitrary POST bodies.
//
// A TimeStampReq carries only a hash of the signature value, nothing about the
// document.

import { NextRequest } from 'next/server';
import { gateEnabled, verifyToken } from '@/lib/serverAuth';
import { tsaCredentials, tsaUrl } from '@/lib/serverTimestamp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A TimeStampReq is ~100 bytes; this leaves room for a policy OID and extensions. */
const MAX_REQUEST_BYTES = 8 * 1024;

/** Tokens run 1.5–6 KiB. */
const MAX_RESPONSE_BYTES = 64 * 1024;

const TIMEOUT_MS = 15_000;

function text(body: string, status: number) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

export async function POST(req: NextRequest) {
  const url = tsaUrl();
  if (!url) {
    return text(
      'This deployment has no timestamp authority configured. Set TSA_URL to enable ' +
        'timestamping (see docs/pdf-signing-v2.md).',
      501
    );
  }

  if (gateEnabled() && !verifyToken(req.headers.get('x-app-auth'))) {
    return new Response('auth_required', {
      status: 401,
      headers: { 'content-type': 'text/plain', 'x-app-auth': 'required' },
    });
  }

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0) return text('Empty timestamp request.', 400);
  if (body.length > MAX_REQUEST_BYTES) {
    return text(`A timestamp request may not exceed ${MAX_REQUEST_BYTES} bytes.`, 413);
  }
  // Minimal check that the body looks like a TimeStampReq: a DER SEQUENCE.
  if (body[0] !== 0x30) return text('That is not a DER TimeStampReq.', 400);

  const credentials = tsaCredentials();

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/timestamp-query',
        // Commercial TSAs usually use HTTP Basic. Credentials stay server-side.
        ...(credentials
          ? { authorization: `Basic ${Buffer.from(credentials).toString('base64')}` }
          : {}),
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (e) {
    const reason = e instanceof Error && e.name === 'TimeoutError' ? 'did not answer in time' : 'could not be reached';
    return text(`The timestamp authority ${reason}.`, 504);
  }

  if (!upstream.ok) {
    return text(`The timestamp authority answered ${upstream.status}.`, 502);
  }

  const answer = new Uint8Array(await upstream.arrayBuffer());
  if (answer.length === 0) return text('The timestamp authority sent an empty reply.', 502);
  if (answer.length > MAX_RESPONSE_BYTES) {
    return text('The timestamp authority sent an implausibly large reply.', 502);
  }

  // Passed through unparsed. Status, imprint and nonce are checked in the
  // browser, which holds the values to compare against
  // (lib/export/pdf/sign/timestamp.ts).
  return new Response(answer, {
    status: 200,
    headers: { 'content-type': 'application/timestamp-reply', 'cache-control': 'no-store' },
  });
}
