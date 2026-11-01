import type { NextRequest } from 'next/server';
import { authenticateClient, mcpEnabled, revokeToken } from '@/lib/mcp/oauth';
import {
  disabledResponse,
  jsonResponse,
  oauthErrorResponse,
  preflightResponse,
  readFormParams,
} from '@/lib/mcp/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// RFC 7009: answers 200 whether or not the token existed.
export async function POST(request: NextRequest) {
  if (!mcpEnabled()) return disabledResponse();
  try {
    const params = await readFormParams(request);
    const client = await authenticateClient(params, request.headers.get('authorization'));
    await revokeToken(params, client);
    return jsonResponse({});
  } catch (err) {
    return oauthErrorResponse(err);
  }
}

export function OPTIONS() {
  return preflightResponse();
}
