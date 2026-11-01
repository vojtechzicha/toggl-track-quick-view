'use client';

// Settings → Claude connector: the connector address and the connected apps,
// each with Disconnect. Loads when the section is opened (app/api/mcp/connections).

import { useCallback, useEffect, useState } from 'react';
import { loadAuth } from '@/lib/source/auth';

interface Connection {
  id: string;
  client_name: string;
  scopes: string[];
  created_at: string | null;
  last_used_at: string | null;
}

async function api<T>(method: string, search = ''): Promise<T> {
  const auth = loadAuth();
  const res = await fetch(`/api/mcp/connections${search}`, {
    method,
    headers: auth?.token ? { 'x-app-auth': auth.token } : {},
    cache: 'no-store',
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
  if (!res.ok) throw new Error(body.detail ?? body.error ?? `HTTP ${res.status}`);
  return body;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

export default function McpConnections({ open }: { open: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ url: string; connections: Connection[] }>('GET');
      setUrl(data.url);
      setConnections(data.connections);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const disconnect = async (id: string) => {
    try {
      await api('DELETE', `?id=${encodeURIComponent(id)}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const command = url ? `claude mcp add --transport http --scope user toggl-quick-view ${url}` : '';

  return (
    <>
      <p className="hint">
        Lets Claude read entries, check timesheets and create or update entries through this
        deployment. In claude.ai: Settings → Connectors → Add custom connector, with the address
        below. In Claude Code, run the command, then <code>/mcp</code> to sign in. Approving asks
        for the app password.
      </p>
      {url && (
        <div className="field">
          <label>Connector address</label>
          <input type="text" readOnly value={url} onFocus={(e) => e.target.select()} />
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              navigator.clipboard?.writeText(command).then(() => setCopied(true));
            }}
          >
            {copied ? 'Copied' : 'Copy the Claude Code command'}
          </button>
        </div>
      )}
      {error && <div className="err-msg">{error}</div>}
      {connections && connections.length === 0 && <p className="hint">No app is connected.</p>}
      {connections && connections.length > 0 && (
        <ul className="ws-list">
          {connections.map((c) => (
            <li key={c.id} className="ws-row">
              <span className="ws-name" style={{ cursor: 'default' }}>
                <span className="ws-name-text">
                  {c.client_name} · {c.scopes.includes('timesheet:write') ? 'read and write' : 'read only'}
                  <br />
                  <small className="hint">
                    Connected {when(c.created_at)} · last used {when(c.last_used_at)}
                  </small>
                </span>
              </span>
              <button type="button" className="btn" onClick={() => disconnect(c.id)}>
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
