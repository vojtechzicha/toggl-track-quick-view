// Connected Claude apps for Settings → Claude connector.
//
// GET    → { url, connections: [{ id, client_name, scopes, created_at, last_used_at }] }
// DELETE ?id=<grant id> → { ok: true }   (revokes the grant and its tokens)
//
// Gated by the password session (x-app-auth), like /api/sync.

import type { NextRequest } from 'next/server';
import { verifyToken } from '@/lib/serverAuth';
import { getMcpResourceUrl, getPublicOrigin, mcpEnabled } from '@/lib/mcp/oauth';
import { getMcpStore } from '@/lib/mcp/store';
import { jsonRes, storeError } from '@/lib/store/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function guard(req: NextRequest): Response | null {
  if (!mcpEnabled()) {
    return jsonRes({ error: 'The Claude connector needs MONGODB_URI and APP_PASSWORD.' }, 404);
  }
  if (!verifyToken(req.headers.get('x-app-auth'))) {
    return new Response(JSON.stringify({ error: 'auth_required' }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-app-auth': 'required' },
    });
  }
  return null;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  try {
    const grants = await getMcpStore().listActiveGrants();
    return jsonRes(
      {
        url: getMcpResourceUrl(getPublicOrigin(req.headers)),
        connections: grants.map((g) => ({
          id: String(g._id),
          client_name: g.client_name ?? 'MCP client',
          scopes: g.scopes ?? [],
          created_at: iso(g.created_at),
          last_used_at: iso(g.last_used_at),
        })),
      },
      200
    );
  } catch (e) {
    return storeError(e);
  }
}

export async function DELETE(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return jsonRes({ error: 'Missing id.' }, 400);
  try {
    await getMcpStore().revokeGrant(id);
    return jsonRes({ ok: true }, 200);
  } catch (e) {
    return storeError(e);
  }
}
