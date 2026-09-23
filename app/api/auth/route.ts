// Password gate login. POST { password } -> { token, exp }, or 401.
// See lib/serverAuth.ts.

import { NextRequest } from 'next/server';
import { gateEnabled, verifyPassword, issueToken } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Best-effort brute-force throttle, reset by a correct password. It is per
// server instance, so serverless scaling weakens it; rely on a strong
// APP_PASSWORD.
let consecutiveFailures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function POST(req: NextRequest) {
  if (!gateEnabled()) {
    return Response.json({ error: 'Password gate is not enabled.' }, { status: 400 });
  }

  let password = '';
  try {
    const body = await req.json();
    if (typeof body?.password === 'string') password = body.password;
  } catch {
    /* malformed body -> treated as a failed attempt below */
  }

  if (!verifyPassword(password)) {
    consecutiveFailures += 1;
    await sleep(Math.min(consecutiveFailures * 250, 5000));
    return Response.json({ error: 'Incorrect password.' }, { status: 401 });
  }

  consecutiveFailures = 0;
  const { token, exp } = issueToken();
  return Response.json({ token, exp });
}
