// Reports whether the server already holds a Toggl token (via TOGGL_API_TOKEN).
// When true, the client runs in "server-managed" mode: it connects without a
// browser token and hides the token UI entirely. The token value itself is
// never exposed — only its presence.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ serverToken: !!process.env.TOGGL_API_TOKEN });
}
