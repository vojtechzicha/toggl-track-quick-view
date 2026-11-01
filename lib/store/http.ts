// Response helpers for the routes that read and write the database.

export function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * 502 for a database error. The cause is logged and returned in `detail`.
 * Safe to expose because only gated users reach these routes, and it makes
 * a bad Atlas URI or network-access list diagnosable.
 */
export function storeError(e: unknown): Response {
  const detail = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  console.error('[store]', e);
  return jsonRes({ error: 'Failed to reach the store.', detail }, 502);
}
