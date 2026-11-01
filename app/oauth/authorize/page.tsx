import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { MCP_SCOPES, getPublicOrigin, mcpEnabled, validateAuthorizeRequest } from '@/lib/mcp/oauth';
import { decideMcpAuthorization } from './actions';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Connect Claude · Toggl Quick View',
  robots: { index: false },
};

// OAuth authorization endpoint for the MCP connector (lib/mcp/oauth.ts). The
// app has no accounts, so approving takes the app password.
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
  ) as Record<string, string | undefined>;
  const pwError = params.pw_error === '1';
  delete params.pw_error;

  if (!mcpEnabled()) {
    return (
      <Shell title="Claude connector is off">
        <p className="hint">This deployment needs MONGODB_URI and APP_PASSWORD for the connector.</p>
      </Shell>
    );
  }

  const origin = getPublicOrigin(await headers());
  const validation = await validateAuthorizeRequest(params, origin);
  if (!validation.ok) {
    if (validation.redirectTo) redirect(validation.redirectTo);
    return (
      <Shell title="Cannot connect">
        <div className="err-msg">{validation.error}</div>
      </Shell>
    );
  }

  const { request } = validation;
  const canWrite = request.scopes.includes(MCP_SCOPES.WRITE);

  return (
    <Shell title="Connect Claude">
      <form action={decideMcpAuthorization} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <p className="hint">
          <strong>{request.clientName}</strong> wants to use this dashboard&apos;s Toggl account: read
          time entries, projects, tags and timesheets{canWrite ? ', and create or update entries' : ''}.
          It returns to <strong>{new URL(request.redirectUri).host}</strong>.
        </p>
        <input type="hidden" name="params" value={JSON.stringify(params)} />

        {canWrite && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <label>
              <input type="radio" name="access" value="write" defaultChecked /> Read and write entries
            </label>
            <label>
              <input type="radio" name="access" value="read" /> Read only
            </label>
          </fieldset>
        )}
        {!canWrite && <input type="hidden" name="access" value="read" />}

        <div className="field">
          <label htmlFor="password">App password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" autoFocus />
        </div>
        {pwError && <div className="err-msg">Incorrect password.</div>}

        <div className="row">
          <button className="btn" type="submit" name="decision" value="deny">
            Deny
          </button>
          <button className="btn btn-primary" type="submit" name="decision" value="allow">
            Allow
          </button>
        </div>
      </form>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overlay">
      <div className="panel">
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}
