'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { verifyPassword } from '@/lib/serverAuth';
import {
  MCP_SCOPES,
  buildRedirect,
  getPublicOrigin,
  issueAuthorizationCode,
  mcpEnabled,
  validateAuthorizeRequest,
} from '@/lib/mcp/oauth';

// Best-effort brute-force throttle, as on /api/auth: per server instance,
// reset by a correct password.
let consecutiveFailures = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readParams(formData: FormData): Record<string, string> {
  try {
    const parsed = JSON.parse(String(formData.get('params') ?? '{}')) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([k, v]) => typeof v === 'string' && k !== 'pw_error')
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * The consent page posts the original authorize query back here, so the
 * request is validated again on the server rather than trusted from the page.
 * Approving needs the app password; there are no user accounts.
 */
export async function decideMcpAuthorization(formData: FormData) {
  if (!mcpEnabled()) redirect('/');
  const params = readParams(formData);
  const origin = getPublicOrigin(await headers());
  const validation = await validateAuthorizeRequest(params, origin);
  if (!validation.ok) {
    redirect(validation.redirectTo ?? `/oauth/authorize?${new URLSearchParams(params)}`);
  }
  const { request } = validation;

  if (formData.get('decision') !== 'allow') {
    redirect(buildRedirect(request.redirectUri, { error: 'access_denied', state: request.state, iss: origin }));
  }

  if (!verifyPassword(String(formData.get('password') ?? ''))) {
    consecutiveFailures += 1;
    await sleep(Math.min(consecutiveFailures * 250, 5000));
    redirect(`/oauth/authorize?${new URLSearchParams({ ...params, pw_error: '1' })}`);
  }
  consecutiveFailures = 0;

  const allowWrite = formData.get('access') === 'write';
  const scopes = allowWrite ? request.scopes : request.scopes.filter((s) => s === MCP_SCOPES.READ);
  const code = await issueAuthorizationCode(request, scopes);
  redirect(buildRedirect(request.redirectUri, { code, state: request.state, iss: origin }));
}
