import type { NextRequest } from 'next/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpServer } from '@/lib/mcp/server';
import {
  getProtectedResourceMetadataUrl,
  getPublicOrigin,
  mcpEnabled,
  verifyAccessToken,
} from '@/lib/mcp/oauth';
import { CORS_HEADERS, checkRateLimit, disabledResponse, jsonResponse, preflightResponse } from '@/lib/mcp/http';
import { useAppTimeZone } from '@/lib/mcp/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Local dates and the timesheet builders follow the process's zone.
useAppTimeZone();

// Remote MCP endpoint (Streamable HTTP, stateless, JSON responses). Claude
// connectors authenticate with an OAuth bearer token from /api/mcp/oauth/token.
async function authenticate(request: NextRequest) {
  const origin = getPublicOrigin(request.headers);
  const match = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i);
  const auth = match ? await verifyAccessToken(match[1].trim(), origin) : null;
  if (auth) return { auth, origin };

  const challenge = [
    `Bearer resource_metadata="${getProtectedResourceMetadataUrl(origin)}"`,
    match ? `error="invalid_token"` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return {
    response: jsonResponse(
      {
        error: match ? 'invalid_token' : 'unauthorized',
        error_description: 'Sign in through the Claude connector.',
      },
      401,
      { 'WWW-Authenticate': challenge }
    ),
  };
}

export async function POST(request: NextRequest) {
  if (!mcpEnabled()) return disabledResponse();
  const result = await authenticate(request);
  if (!result.auth) return result.response;

  const limit = checkRateLimit(`mcp:${result.auth.grantId}`, { limit: 300, windowMs: 60 * 1000 });
  if (!limit.success) {
    return jsonResponse({ error: 'rate_limited', error_description: 'Too many requests.' }, 429, {
      'Retry-After': String(Math.ceil((limit.resetTime - Date.now()) / 1000)),
    });
  }

  useAppTimeZone();
  const server = createMcpServer(result.auth, result.origin);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, {
      authInfo: {
        token: result.auth.token,
        clientId: result.auth.clientId,
        scopes: result.auth.scopes,
        expiresAt: result.auth.expiresAt,
      },
    });
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) headers.set(key, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } finally {
    await server.close();
  }
}

// Stateless: no server-initiated SSE stream and no sessions to end.
// Unauthenticated requests still get the 401 challenge so clients can discover
// the OAuth server.
async function methodNotAllowed(request: NextRequest) {
  if (!mcpEnabled()) return disabledResponse();
  const result = await authenticate(request);
  if (!result.auth) return result.response;
  return jsonResponse({ error: 'method_not_allowed' }, 405, { Allow: 'POST, OPTIONS' });
}

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;

export function OPTIONS() {
  return preflightResponse();
}
