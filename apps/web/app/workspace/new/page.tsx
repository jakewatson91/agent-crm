'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface ConnectorMeta {
  type: string;
  category: 'tool' | 'preset';
  description?: string;
  schedule_cron?: string;
  config_schema?: Record<string, unknown>;
}

const ABOUT_PLACEHOLDER = `Examples:

"Find B2B SaaS companies hiring GTM roles, draft outreach to founders"

"Track real estate listings under $500k in Boulder; flag new ones to me"

"Monitor competitors' product launches and write summary briefs"

"Recruit talent partners for early-stage AI startups"`;

export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [connectors, setConnectors] = useState<ConnectorMeta[]>([]);
  const [sourceType, setSourceType] = useState<string>('');
  const [sourceName, setSourceName] = useState('');
  const [resendKey, setResendKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/sources/connectors').then((r) => r.json()).then((j) => {
      setConnectors((j.connectors ?? []) as ConnectorMeta[]);
    }).catch(() => {});
  }, []);

  async function submit() {
    setErr(null);
    if (!name.trim() || !about.trim()) {
      setErr('Name and description are both required.');
      return;
    }
    setSubmitting(true);
    try {
      const starter_source = sourceType && sourceName.trim()
        ? { connector_type: sourceType, name: sourceName.trim(), config: {} }
        : null;
      const r = await fetch('/api/workspaces/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          about: about.trim(),
          resend_api_key: resendKey.trim() || undefined,
          starter_source,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'create failed'); setSubmitting(false); return; }
      router.push(`/workspace/${j.workspace_id}/channels`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const labelStyle: React.CSSProperties = { fontSize: '.85rem', color: 'var(--text-2)', marginBottom: '.25rem', display: 'block', fontWeight: 500 };
  const helpStyle: React.CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: '.5rem' };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '.6rem .75rem', background: 'var(--panel)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: '.9rem',
  };
  const textareaStyle: React.CSSProperties = { ...inputStyle, lineHeight: 1.5 };

  return (
    <main style={{ padding: '2rem', maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '.25rem' }}>New workspace</h1>
      <p style={{ color: 'var(--text-3)', marginBottom: '1.5rem', fontSize: '.9rem' }}>
        Tell the agent what you want it to help with. Refine in Settings later.
      </p>

      <div style={{ marginBottom: '1.25rem' }}>
        <label style={labelStyle}>Workspace name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} placeholder="e.g. job-hunt, listings-boulder, partners-eu" />
      </div>

      <div style={{ marginBottom: '1.25rem' }}>
        <label style={labelStyle}>What should the agent help with?</label>
        <div style={helpStyle}>One or two plain sentences. Defaults for tone, ICP, and writing rules get derived from this — you can edit any of them later.</div>
        <textarea value={about} onChange={(e) => setAbout(e.target.value)} rows={6} style={textareaStyle} placeholder={ABOUT_PLACEHOLDER} />
      </div>

      <details style={{ marginBottom: '1.25rem', padding: '.5rem 0', borderTop: '1px solid var(--border)' }}>
        <summary style={{ cursor: 'pointer', fontSize: '.85rem', color: 'var(--text-2)', padding: '.5rem 0' }}>
          Add a first data source (optional)
        </summary>
        <div style={{ marginTop: '.75rem' }}>
          <label style={labelStyle}>Source type</label>
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} style={inputStyle}>
            <option value="">— skip —</option>
            {connectors.map((c) => (
              <option key={c.type} value={c.type}>{c.type} ({c.category})</option>
            ))}
          </select>
          {sourceType && (
            <div style={{ marginTop: '.75rem' }}>
              <label style={labelStyle}>Source name</label>
              <input value={sourceName} onChange={(e) => setSourceName(e.target.value)} style={inputStyle} placeholder="e.g. yc-w26" />
              <div style={helpStyle}>You can finish configuring (URLs, query, schedule) on the Sources page after.</div>
            </div>
          )}
        </div>
      </details>

      <details style={{ marginBottom: '1.5rem', padding: '.5rem 0', borderTop: '1px solid var(--border)' }}>
        <summary style={{ cursor: 'pointer', fontSize: '.85rem', color: 'var(--text-2)', padding: '.5rem 0' }}>
          Email setup (optional)
        </summary>
        <div style={{ marginTop: '.75rem' }}>
          <label style={labelStyle}>Resend API key</label>
          <input value={resendKey} onChange={(e) => setResendKey(e.target.value)} type="password" style={inputStyle} placeholder="re_..." />
          <div style={helpStyle}>Skip if you don&apos;t plan to send email yet. Drafts still get created and gated, just not sent.</div>
        </div>
      </details>

      {err && <div style={{ color: '#f7768e', fontSize: '.85rem', marginBottom: '1rem' }}>✗ {err}</div>}

      <button onClick={submit} disabled={submitting} style={{
        padding: '.65rem 1.25rem', background: '#9ece6a', color: '#000', border: 'none',
        borderRadius: 6, cursor: 'pointer', fontWeight: 500, opacity: submitting ? 0.5 : 1,
      }}>
        {submitting ? 'creating…' : 'Create workspace'}
      </button>
    </main>
  );
}
