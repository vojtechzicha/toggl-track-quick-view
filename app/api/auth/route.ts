// Password gate login endpoint.
//
// POST { password } -> { token, exp } on success, 401 on a wrong password.
// The password is checked (timing-safe) against APP_PASSWORD and immediately
// discarded; only the signed session token is returned. See lib/serverAuth.ts.

import { NextRequest } from 'next/server';
import { gateEnabled, verifyPassword, issueToken } from '@/lib/serverAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Best-effort in-memory brute-force throttle. A correct password resets it.
// Per server instance (like lib/serverCache), so it's not airtight across a
// fanned-out serverless deploy — a strong APP_PASSWORD is the real defense.
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
