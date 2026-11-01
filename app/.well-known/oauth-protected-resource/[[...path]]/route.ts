import type { NextRequest } from 'next/server';
import { getProtectedResourceMetadata, getPublicOrigin, mcpEnabled } from '@/lib/mcp/oauth';
import { disabledResponse, jsonResponse, preflightResponse } from '@/lib/mcp/http';

export const dynamic = 'force-dynamic';

// RFC 9728 metadata for the MCP endpoint. Clients ask for both
// /.well-known/oauth-protected-resource and
// /.well-known/oauth-protected-resource/api/mcp.
export async function GET(request: NextRequest) {
  if (!mcpEnabled()) return disabledResponse();
  return jsonResponse(getProtectedResourceMetadata(getPublicOrigin(request.headers)));
}

export function OPTIONS() {
  return preflightResponse();
}
