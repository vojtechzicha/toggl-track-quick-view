// HTTP helpers for the MCP and OAuth endpoints.

import { OAuthError } from './oauth';

// MCP and OAuth endpoints are called by Claude's servers and by browser-based
// MCP clients. They authenticate with bearer tokens, never cookies, so open
// CORS is safe.
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { ...CORS_HEADERS, 'Cache-Control': 'no-store', ...headers },
  });
}

export function oauthErrorResponse(err: unknown) {
  if (err instanceof OAuthError) {
    return jsonResponse({ error: err.code, error_description: err.message }, err.status);
  }
  console.error('MCP OAuth error:', err);
  return jsonResponse({ error: 'server_error', error_description: 'Internal error.' }, 500);
}

export function preflightResponse() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** 404 when the deployment has no database or password (see mcpEnabled). */
export function disabledResponse() {
  return jsonResponse(
    {
      error: 'not_available',
      error_description: 'The Claude connector needs MONGODB_URI and APP_PASSWORD on this deployment.',
    },
    404
  );
}

/** OAuth endpoints take application/x-www-form-urlencoded; JSON is accepted as a courtesy. */
export async function readFormParams(request: Request): Promise<URLSearchParams> {
  const contentType = request.headers.get('content-type') || '';
  const text = await request.text();
  if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(
        Object.entries(data)
          .filter(([, value]) => typeof value === 'string')
          .map(([key, value]) => [key, value as string])
      );
    } catch {
      throw new OAuthError('invalid_request', 'Malformed JSON body.');
    }
  }
  return new URLSearchParams(text);
}

export function clientIp(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

// Fixed-window rate limit, in memory and per function instance: it resets on
// cold starts and isn't shared between instances, which is enough to blunt a
// runaway client.
const windows = new Map<string, { count: number; resetTime: number }>();

export function checkRateLimit(key: string, { limit, windowMs }: { limit: number; windowMs: number }) {
  const now = Date.now();
  if (Math.random() < 0.01) {
    for (const [k, e] of windows) if (now >= e.resetTime) windows.delete(k);
  }
  const entry = windows.get(key);
  if (!entry || now >= entry.resetTime) {
    const resetTime = now + windowMs;
    windows.set(key, { count: 1, resetTime });
    return { success: true, resetTime };
  }
  if (entry.count >= limit) return { success: false, resetTime: entry.resetTime };
  entry.count++;
  return { success: true, resetTime: entry.resetTime };
}
