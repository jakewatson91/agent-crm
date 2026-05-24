'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface CatalogAction { slug: string; scope: 'read' | 'write' | 'dangerous'; summary: string }
interface CatalogToolkit { slug: string; label: string; description: string; actions: CatalogAction[] }

interface ConnectionRow {
  id: string;
  toolkit_slug: string;
  composio_connection_id: string | null;
  status: 'initiated' | 'active' | 'expired' | 'failed' | 'inactive' | string;
  connect_url: string | null;
  profile: Record<string, unknown>;
  last_error: string | null;
  updated_at: string;
}

const STATUS_COLOR: Record<string, string> = {
  active: '#1e7e34',
  initiated: '#a37200',
  expired: '#7a3a3a',
  failed: '#7a3a3a',
  inactive: '#555',
};

export function ConnectedServices({ workspace_id }: { workspace_id: string }) {
  const [toolkits, setToolkits] = useState<CatalogToolkit[]>([]);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollersRef = useRef<Record<string, number>>({});

  const refreshConnections = useCallback(async () => {
    const r = await fetch(`/api/composio/connections?workspace_id=${workspace_id}`);
    const j = await r.json();
    if (Array.isArray(j.connections)) setConnections(j.connections);
  }, [workspace_id]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/composio/toolkits')
      .then((r) => r.json())
      .then((j) => { if (!cancelled && Array.isArray(j.toolkits)) setToolkits(j.toolkits); });
    refreshConnections();
    return () => { cancelled = true; };
  }, [refreshConnections]);

  const connect = async (toolkit_slug: string) => {
    setError(null);
    setBusy(toolkit_slug);
    try {
      const r = await fetch('/api/composio/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace_id, toolkit_slug }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'authorize failed');
      window.open(j.redirect_url, '_blank', 'noopener');
      await refreshConnections();
      pollUntilActive(j.connection_id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // After opening the OAuth URL in a new tab, poll /refresh every 3s until
  // the row transitions to active (or 5 minutes elapse).
  const pollUntilActive = (composio_connection_id: string) => {
    const start = Date.now();
    const tick = async () => {
      if (Date.now() - start > 5 * 60 * 1000) return;
      const conn = connections.find((c) => c.composio_connection_id === composio_connection_id)
        ?? (await fetchOne(composio_connection_id));
      if (!conn) return;
      const r = await fetch(`/api/composio/connections/${conn.id}/refresh`, { method: 'POST' });
      if (r.ok) {
        await refreshConnections();
        const updated = (await (await fetch(`/api/composio/connections?workspace_id=${workspace_id}`)).json())
          .connections as ConnectionRow[];
        const hit = updated.find((c) => c.composio_connection_id === composio_connection_id);
        if (hit?.status === 'active') return;
      }
      pollersRef.current[composio_connection_id] = window.setTimeout(tick, 3000);
    };
    pollersRef.current[composio_connection_id] = window.setTimeout(tick, 3000);
  };

  const fetchOne = async (composio_connection_id: string) => {
    const r = await fetch(`/api/composio/connections?workspace_id=${workspace_id}`);
    const j = await r.json();
    return (j.connections as ConnectionRow[]).find((c) => c.composio_connection_id === composio_connection_id);
  };

  const disconnect = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const r = await fetch(`/api/composio/connections/${id}`, { method: 'DELETE' });
      if (!r.ok) {
        const j = await r.json();
        throw new Error(j.error ?? 'disconnect failed');
      }
      await refreshConnections();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const connByToolkit = new Map(connections.map((c) => [c.toolkit_slug, c]));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
      <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>
        Connect external accounts the agent can read from and write to: email, calendar, CRM, chat. Each connection uses OAuth — credentials live at Composio, not in agent-crm.
      </div>

      {error && (
        <div style={{ padding: '.5rem .75rem', borderRadius: 6, background: '#3a1a1a', color: '#f7c5c5', fontSize: '.78rem' }}>
          {error}
        </div>
      )}

      {toolkits.length === 0 && (
        <div style={{ fontSize: '.78rem', color: 'var(--text-3)' }}>Loading toolkits…</div>
      )}

      {toolkits.map((tk) => {
        const conn = connByToolkit.get(tk.slug);
        const status = conn?.status;
        const profileEmail = (conn?.profile as { emailAddress?: string; email?: string } | undefined)?.emailAddress
          ?? (conn?.profile as { email?: string } | undefined)?.email;
        return (
          <div key={tk.slug} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '.75rem 1rem', display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.75rem' }}>
              <div>
                <div style={{ fontSize: '.92rem', fontWeight: 500 }}>{tk.label}</div>
                <div style={{ fontSize: '.74rem', color: 'var(--text-3)' }}>{tk.description}</div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                {status && (
                  <span style={{ padding: '.15rem .5rem', borderRadius: 999, fontSize: '.7rem', background: STATUS_COLOR[status] ?? '#555', color: 'white' }}>
                    {status}
                  </span>
                )}
                {!conn && (
                  <button onClick={() => connect(tk.slug)} disabled={busy === tk.slug} style={btn}>
                    {busy === tk.slug ? 'Opening…' : 'Connect'}
                  </button>
                )}
                {conn && status !== 'active' && conn.connect_url && (
                  <button onClick={() => window.open(conn.connect_url!, '_blank', 'noopener')} style={btn}>
                    Resume OAuth
                  </button>
                )}
                {conn && (
                  <button onClick={() => disconnect(conn.id)} disabled={busy === conn.id} style={{ ...btn, background: 'transparent', color: 'var(--text-2)' }}>
                    {busy === conn.id ? '…' : 'Disconnect'}
                  </button>
                )}
              </div>
            </div>

            {profileEmail && (
              <div style={{ fontSize: '.74rem', color: 'var(--text-2)' }}>Connected as <strong>{profileEmail}</strong></div>
            )}
            {conn?.last_error && (
              <div style={{ fontSize: '.72rem', color: '#f7c5c5' }}>{conn.last_error}</div>
            )}

            <details style={{ marginTop: '.25rem' }}>
              <summary style={{ fontSize: '.72rem', color: 'var(--text-3)', cursor: 'pointer' }}>
                {tk.actions.length} action{tk.actions.length === 1 ? '' : 's'} the agent can use
              </summary>
              <ul style={{ margin: '.4rem 0 0', padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
                {tk.actions.map((a) => (
                  <li key={a.slug} style={{ fontSize: '.72rem', color: 'var(--text-2)' }}>
                    <span style={{ display: 'inline-block', minWidth: 64, padding: '.05rem .35rem', marginRight: '.5rem', borderRadius: 4, background: a.scope === 'dangerous' ? '#3a1a1a' : a.scope === 'write' ? '#3a2a1a' : '#1a2a3a', fontSize: '.66rem', textAlign: 'center' }}>
                      {a.scope}
                    </span>
                    {a.summary}
                  </li>
                ))}
              </ul>
            </details>
          </div>
        );
      })}
    </div>
  );
}

const btn: React.CSSProperties = {
  padding: '.3rem .75rem',
  borderRadius: 6,
  border: '1px solid var(--border)',
  background: 'var(--panel-2)',
  color: 'var(--text-1)',
  fontSize: '.78rem',
  cursor: 'pointer',
};
