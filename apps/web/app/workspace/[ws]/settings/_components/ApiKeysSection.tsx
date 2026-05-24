'use client';

import { useCallback, useEffect, useState } from 'react';

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_by: string;
}

export function ApiKeysSection({ workspace_id }: { workspace_id: string }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [justCreated, setJustCreated] = useState<{ key: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetch(`/api/workspace/api-keys/list?workspace_id=${workspace_id}`).then((r) => r.json());
    setKeys(r.keys ?? []);
    setLoading(false);
  }, [workspace_id]);

  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/workspace/api-keys/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, name: newName }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'create failed'); return; }
      setJustCreated({ key: j.key, name: j.name });
      setNewName('');
      setShowCreate(false);
      await load();
    } finally { setBusy(false); }
  }

  async function revoke(id: string, name: string) {
    if (!confirm(`Revoke key "${name}"? This cannot be undone.`)) return;
    const r = await fetch('/api/workspace/api-keys/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (!r.ok) { const j = await r.json(); setErr(j.error ?? 'revoke failed'); return; }
    await load();
  }

  async function copyKey() {
    if (!justCreated) return;
    await navigator.clipboard.writeText(justCreated.key);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) return <p style={{ color: 'var(--text-3)' }}>loading…</p>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div style={{ fontSize: '.78rem', color: 'var(--text-3)', lineHeight: 1.5 }}>
        Bearer tokens for the MCP endpoint at <code style={{ fontFamily: 'monospace' }}>/api/mcp</code>. Used by
        external agents and integrations. Treat them like passwords — they grant full
        tool access for this workspace.
      </div>

      {justCreated && (
        <div style={{ padding: '.85rem 1rem', border: '1px solid #9ece6a', borderRadius: 8, background: 'rgba(158, 206, 106, 0.08)' }}>
          <div style={{ fontSize: '.85rem', marginBottom: '.5rem', color: '#9ece6a' }}>
            ✓ Created "{justCreated.name}". Copy this key — you won't see it again.
          </div>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
            <code style={{ flex: 1, padding: '.4rem .6rem', background: 'var(--bg)', borderRadius: 4, fontFamily: 'monospace', fontSize: '.78rem', overflowX: 'auto', whiteSpace: 'nowrap' }}>
              {justCreated.key}
            </code>
            <button onClick={copyKey} style={smallBtn}>{copied ? '✓ copied' : 'copy'}</button>
            <button onClick={() => setJustCreated(null)} style={smallBtn}>dismiss</button>
          </div>
        </div>
      )}

      {!showCreate ? (
        <div>
          <button onClick={() => setShowCreate(true)} style={primaryBtn(false)}>+ create new key</button>
        </div>
      ) : (
        <form onSubmit={create} style={{ display: 'flex', gap: '.5rem', alignItems: 'center' }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="key name (e.g. 'cursor-mcp')"
            style={inputStyle}
            autoFocus
          />
          <button type="submit" disabled={busy || !newName} style={primaryBtn(busy || !newName)}>
            {busy ? 'creating…' : 'create'}
          </button>
          <button type="button" onClick={() => { setShowCreate(false); setNewName(''); }} style={smallBtn}>cancel</button>
        </form>
      )}
      {err && <div style={{ color: '#f7768e', fontSize: '.85rem' }}>{err}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
        {keys.length === 0 && <p style={{ color: 'var(--text-3)', fontSize: '.85rem' }}>No keys yet.</p>}
        {keys.map((k) => {
          const revoked = !!k.revoked_at;
          return (
            <div key={k.id} style={{ ...row, opacity: revoked ? 0.5 : 1 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '.92rem' }}>
                  {k.name}
                  {revoked && <span style={{ marginLeft: '.5rem', fontSize: '.7rem', color: '#f7768e' }}>revoked</span>}
                </div>
                <div style={{ fontSize: '.7rem', color: 'var(--text-3)', fontFamily: 'monospace' }}>
                  {k.prefix}… · last used {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'never'}
                </div>
              </div>
              {!revoked && <button onClick={() => revoke(k.id, k.name)} style={dangerBtn}>revoke</button>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '.4rem .6rem', background: 'var(--bg)', color: 'var(--text)',
  border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: '.85rem',
  flex: 1, maxWidth: 320,
};
const row: React.CSSProperties = {
  display: 'flex', gap: '.6rem', alignItems: 'center',
  padding: '.55rem .75rem', border: '1px solid var(--border)', borderRadius: 6,
};
const smallBtn: React.CSSProperties = {
  padding: '.3rem .6rem', background: 'transparent', color: 'var(--text-2)',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: '.78rem',
};
const dangerBtn: React.CSSProperties = {
  padding: '.3rem .6rem', background: 'transparent', color: '#f7768e',
  border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', fontSize: '.75rem',
};
function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    padding: '.4rem .8rem', background: '#9ece6a', color: '#000',
    border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '.85rem',
    opacity: disabled ? 0.4 : 1, fontWeight: 500,
  };
}
