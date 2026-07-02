'use client';

import { useState } from 'react';
import type { ConnectorEntry } from './ConnectorHub';

type Role = 'primary' | 'fallback' | 'off';
interface VerifyResult { ok: boolean; status: string; detail: string; credits?: string }

const ACCENT: Record<string, string> = {
  blue: 'var(--accent-blue)', green: 'var(--accent-green)', amber: 'var(--accent-amber)',
  coral: 'var(--accent-coral)', purple: 'var(--accent-purple)',
};

export function ConnectorModal({
  connector, workspace_id, onClose, onSaved,
}: {
  connector: ConnectorEntry;
  workspace_id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const c = connector;
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of c.fields) init[f.key] = f.type === 'secret' ? '' : (c.values[f.key] ?? '');
    return init;
  });
  const [role, setRole] = useState<Role>(c.state.role ?? (c.provider_id ? 'off' : 'off'));
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const isContact = !!c.provider_id;

  /** Write the form to the server. Returns true on success. Does not close. */
  async function persist(): Promise<boolean> {
    setErr(null);
    const r = await fetch('/api/connectors/configure', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspace_id, connector_id: c.id, values,
        ...(isContact ? { contact_role: role } : {}),
      }),
    });
    const j = await r.json();
    if (!r.ok) { setErr(j.error ?? 'save failed'); return false; }
    return true;
  }

  async function save() {
    setSaving(true);
    try {
      if (await persist()) onSaved();
    } finally { setSaving(false); }
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${c.name}? Its keys are removed from this workspace.`)) return;
    setErr(null); setSaving(true);
    try {
      const r = await fetch('/api/connectors/configure', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, connector_id: c.id, disconnect: true }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'disconnect failed'); return; }
      onSaved();
    } finally { setSaving(false); }
  }

  async function runVerify() {
    setVerifying(true); setVerify(null);
    try {
      // Save first so the live check runs against the just-typed key — but don't
      // close the dialog, so the result shows here.
      await persist();
      const r = await fetch('/api/connectors/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, connector_id: c.id }),
      });
      const j = await r.json();
      setVerify(j.result ?? { ok: false, status: 'error', detail: j.error ?? 'check failed' });
    } catch (e) {
      setVerify({ ok: false, status: 'error', detail: e instanceof Error ? e.message : String(e) });
    } finally { setVerifying(false); }
  }

  const accent = ACCENT[c.accent] ?? 'var(--accent-blue)';

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={panel}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '.85rem' }}>
          <div style={{ ...icon, background: accent }}>{c.name[0]}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '1.05rem', fontWeight: 600 }}>{c.name}</div>
            <div style={{ fontSize: '.8rem', color: 'var(--text-2)', lineHeight: 1.45, marginTop: 2 }}>{c.blurb}</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>×</button>
        </div>

        <div style={{ marginTop: '1rem', padding: '.65rem .8rem', borderRadius: 8, background: 'var(--panel-2)' }}>
          <div style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em', color: 'var(--text-3)', marginBottom: '.35rem' }}>What the agent does with it</div>
          <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
            {c.capabilities.map((cap, i) => (
              <li key={i} style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>{cap}</li>
            ))}
          </ul>
        </div>

        {c.model_hint && c.model_hint.length > 0 && (
          <div style={{ marginTop: '.85rem', fontSize: '.74rem', color: 'var(--text-3)' }}>
            Point a model setting at an id like{' '}
            {c.model_hint.map((m, i) => (
              <span key={m}>
                <code style={{ color: 'var(--text-2)' }}>{m}</code>{i < c.model_hint!.length - 1 ? ', ' : ''}
              </span>
            ))}
            . Set the default in <strong>Models → default models</strong>.
          </div>
        )}

        {c.state.from_server.length > 0 && (
          <div style={{ marginTop: '.85rem', padding: '.55rem .75rem', borderRadius: 8, background: 'var(--accent-blue-soft)', color: '#4f6da3', fontSize: '.76rem', lineHeight: 1.45 }}>
            A key for this service is set in the server environment, so it already works. Paste a key below only to use a different one for this workspace.
          </div>
        )}

        <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
          {c.fields.map((f) => {
            const savedSecret = f.type === 'secret' && c.saved[f.key];
            return (
              <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
                <label style={{ fontSize: '.8rem', fontWeight: 500 }}>
                  {f.label}{f.optional ? <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> · optional</span> : null}
                </label>
                {f.help && <div style={{ fontSize: '.72rem', color: 'var(--text-3)' }}>{f.help}</div>}
                <input
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                  placeholder={savedSecret ? '•••• saved — leave blank to keep' : f.placeholder}
                  style={{ ...input, fontFamily: f.type === 'secret' ? 'var(--font-mono)' : 'inherit' }}
                />
              </div>
            );
          })}
        </div>

        {isContact && (
          <div style={{ marginTop: '1rem' }}>
            <div style={{ fontSize: '.8rem', fontWeight: 500, marginBottom: '.35rem' }}>Use this source</div>
            <div style={{ fontSize: '.72rem', color: 'var(--text-3)', marginBottom: '.5rem' }}>
              The agent tries the primary first and only falls back to the backup when the primary finds nobody or errors.
            </div>
            <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap' }}>
              {([['primary', 'Primary'], ['fallback', 'Fallback'], ['off', 'Not used']] as const).map(([val, label]) => (
                <button key={val} onClick={() => setRole(val)} style={roleBtn(role === val)}>{label}</button>
              ))}
            </div>
          </div>
        )}

        {c.get_key_url && (
          <a href={c.get_key_url} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: '.85rem', fontSize: '.76rem' }}>
            Where do I get a key? ↗
          </a>
        )}

        {verify && (
          <div style={{ marginTop: '.85rem', padding: '.55rem .75rem', borderRadius: 8, fontSize: '.78rem',
            background: verify.ok ? 'var(--accent-green-soft)' : 'var(--accent-coral-soft)',
            color: verify.ok ? '#5a7e5f' : '#a14d44' }}>
            {verify.ok ? '✓ ' : '✗ '}{verify.detail}{verify.credits ? ` · ${verify.credits}` : ''}
          </div>
        )}
        {err && <div style={{ marginTop: '.75rem', color: '#a14d44', fontSize: '.8rem' }}>{err}</div>}

        <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '.6rem' }}>
          <button onClick={save} disabled={saving} style={primaryBtn(saving)}>{saving ? 'saving…' : 'Save'}</button>
          {c.verifiable && (
            <button onClick={runVerify} disabled={verifying || saving} style={secondaryBtn}>
              {verifying ? 'testing…' : 'Test connection'}
            </button>
          )}
          <div style={{ flex: 1 }} />
          {(c.state.configured || c.state.role) && (
            <button onClick={disconnect} disabled={saving} style={dangerBtn}>Disconnect</button>
          )}
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(20,18,14,0.45)', zIndex: 100,
  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '6vh 1rem', overflowY: 'auto',
};
const panel: React.CSSProperties = {
  width: '100%', maxWidth: 540, background: 'var(--panel)', border: '1px solid var(--border)',
  borderRadius: 12, padding: '1.35rem 1.4rem', boxShadow: '0 12px 40px rgba(20,18,14,0.18)',
};
const icon: React.CSSProperties = {
  width: 40, height: 40, borderRadius: 9, color: '#fff', display: 'flex', alignItems: 'center',
  justifyContent: 'center', fontWeight: 700, fontSize: '1.1rem', flexShrink: 0,
};
const closeBtn: React.CSSProperties = {
  background: 'transparent', border: 0, color: 'var(--text-3)', fontSize: '1.5rem', lineHeight: 1, cursor: 'pointer', padding: 0,
};
const input: React.CSSProperties = {
  padding: '.5rem .6rem', background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)',
  borderRadius: 6, fontSize: '.85rem', width: '100%',
};
function roleBtn(on: boolean): React.CSSProperties {
  return {
    padding: '.35rem .8rem', fontSize: '.78rem', borderRadius: 999, cursor: 'pointer',
    border: on ? '1px solid var(--text)' : '1px solid var(--border)',
    background: on ? 'var(--text)' : 'var(--bg)', color: on ? 'var(--bg)' : 'var(--text-2)',
  };
}
function primaryBtn(disabled: boolean): React.CSSProperties {
  return { padding: '.5rem 1.1rem', background: 'var(--accent-green)', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontWeight: 500, opacity: disabled ? 0.5 : 1 };
}
const secondaryBtn: React.CSSProperties = {
  padding: '.5rem .9rem', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 7, cursor: 'pointer',
};
const dangerBtn: React.CSSProperties = {
  padding: '.5rem .8rem', background: 'transparent', color: '#a14d44', border: '1px solid var(--border)', borderRadius: 7, cursor: 'pointer', fontSize: '.8rem',
};
