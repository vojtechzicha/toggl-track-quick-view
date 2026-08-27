// Server-side proxy for an RFC 3161 timestamp authority.
//
// The browser cannot POST to a TSA directly: public timestamp authorities send
// no CORS headers, so the request is blocked before it leaves. This route is
// the same-origin side of it.
//
// Three things about its shape are deliberate.
//
//  - **The destination is configuration, never a parameter.** The client sends
//    a TimeStampReq and nothing else; TSA_URL decides where it goes. A proxy
//    that forwarded to a URL from the request body would be an SSRF hole with a
//    timestamp-shaped excuse — anything on the deployment's network, reachable
//    by anyone who can reach this route.
//  - **It is gated like the Toggl proxy.** A qualified timestamp costs money
//    per stamp. An ungated route spends someone else's budget.
//  - **The body is capped.** A TimeStampReq is around a hundred bytes; nothing
//    legitimate is large, so a cap costs nothing and stops this being a
//    general-purpose relay for arbitrary POST bodies.
//
// Nothing about the document reaches the TSA. A TimeStampReq carries a hash of
// the signature and nothing else — not the PDF, not the digest of the PDF, not
// the certificate.

import { NextRequest } from 'next/server';
import { gateEnabled, verifyToken } from '@/lib/serverAuth';
import { tsaCredentials, tsaUrl } from '@/lib/serverTimestamp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A TimeStampReq is ~100 bytes. This is room for a policy OID and extensions. */
const MAX_REQUEST_BYTES = 8 * 1024;

/** A token is 1.5–6 KiB; a TSA sending far more is not sending a timestamp. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** How long to wait before deciding the TSA is not going to answer. */
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
  // Cheapest possible sanity check that this is a TimeStampReq and not somebody
  // using the route to post arbitrary bytes somewhere: DER SEQUENCE.
  if (body[0] !== 0x30) return text('That is not a DER TimeStampReq.', 400);

  const credentials = tsaCredentials();

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/timestamp-query',
        // A commercial TSA usually authenticates with HTTP Basic. Kept server
        // side, exactly like the Toggl token.
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

  // Passed through unparsed. Everything about whether this token is the right
  // answer — status, imprint, nonce — is checked in the browser, where the
  // request was made and where the values to compare against are (see
  // lib/export/pdf/sign/timestamp.ts). Checking here as well would be a second
  // implementation that could disagree with the one that matters.
  return new Response(answer, {
    status: 200,
    headers: { 'content-type': 'application/timestamp-reply', 'cache-control': 'no-store' },
  });
}
