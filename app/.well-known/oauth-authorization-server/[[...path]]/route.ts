import type { NextRequest } from 'next/server';
import { getAuthorizationServerMetadata, getPublicOrigin, mcpEnabled } from '@/lib/mcp/oauth';
import { disabledResponse, jsonResponse, preflightResponse } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';

// RFC 8414 metadata of the authorization server behind the MCP endpoint.
export async function GET(request: NextRequest) {
  if (!mcpEnabled()) return disabledResponse();
  return jsonResponse(getAuthorizationServerMetadata(getPublicOrigin(request.headers)));
}

export function OPTIONS() {
  return preflightResponse();
}
