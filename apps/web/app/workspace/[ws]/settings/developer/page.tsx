'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { EnvVarsEditor } from '../_components/EnvVarsEditor';
import { DeveloperView } from '../_components/DeveloperView';

interface Workspace {
  id: string;
  policy: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export default function SettingsDeveloperPage() {
  const params = useParams<{ ws: string }>();
  const [ws, setWs] = useState<Workspace | null>(null);
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [devUnlocked, setDevUnlocked] = useState(false);
  const [devPolicy, setDevPolicy] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    const r = await fetch(`/api/workspace/get?workspace_id=${params.ws}`);
    const j = await r.json();
    if (!j.workspace) return;
    const w = j.workspace as Workspace;
    setWs(w);
    const policy = (w.policy ?? {}) as Record<string, any>;
    setDevPolicy(policy);
    setEnvVars((policy.env ?? {}) as Record<string, string>);
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [params.ws]);

  async function save() {
    setErr(null); setMsg(null); setSaving(true);
    try {
      const policy = devUnlocked
        ? { ...devPolicy, env: filterEmpty(envVars) }
        : { ...(ws?.policy ?? {}), env: filterEmpty(envVars) };
      const r = await fetch('/api/workspace/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: params.ws, policy }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'save failed'); return; }
      setMsg(`saved at ${new Date().toLocaleTimeString()}`);
      await load();
    } finally { setSaving(false); }
  }

  if (!ws) return <div><h2 style={{ marginTop: 0 }}>Developer</h2><p style={{ color: 'var(--text-3)' }}>loading…</p></div>;

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Developer</h2>

      {devUnlocked && (
        <div style={{ marginTop: '1rem', padding: '.5rem .75rem', borderRadius: 6, background: '#3a1a1a', color: '#f7c5c5', fontSize: '.78rem' }}>
          Developer view is unlocked. Saving will write the raw policy below verbatim — bypasses all friendly-form validation.
        </div>
      )}

      <div style={{ marginTop: '1rem' }}>
        <details open style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '.5rem .75rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '.85rem', color: 'var(--text-2)' }}>
            Environment variables
            <span style={{ fontSize: '.7rem', color: 'var(--text-3)', marginLeft: '.5rem' }}>
              keys + model overrides. Empty rows fall through to env.
            </span>
          </summary>
          <div style={{ marginTop: '.75rem' }}>
            <EnvVarsEditor value={envVars} onChange={setEnvVars} />
          </div>
        </details>
      </div>

      <div style={{ marginTop: '.75rem' }}>
        <DeveloperView
          policy={devUnlocked ? devPolicy : (ws.policy ?? {})}
          workspaceMeta={{ id: ws.id, created_at: ws.created_at, updated_at: ws.updated_at }}
          unlocked={devUnlocked}
          onUnlockChange={setDevUnlocked}
          onPolicyChange={setDevPolicy}
        />
      </div>

      <div style={{ marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '.75rem' }}>
        <button onClick={save} disabled={saving} style={{ padding: '.5rem 1rem', background: '#9ece6a', color: '#000', border: 'none', borderRadius: 6, cursor: 'pointer', opacity: saving ? 0.4 : 1 }}>
          {saving ? 'saving…' : 'save'}
        </button>
        {msg && <span style={{ color: '#9ece6a', fontSize: '.85rem' }}>✓ {msg}</span>}
        {err && <span style={{ color: '#f7768e', fontSize: '.85rem' }}>✗ {err}</span>}
      </div>
    </div>
  );
}

function filterEmpty(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (k && v && v.length) out[k] = v;
  }
  return out;
}
