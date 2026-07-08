'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CsvImportPanel } from '../../_components/CsvImportPanel';

interface ConnectorMeta {
  type: string;
  category: 'tool' | 'preset';
  description?: string;
  schedule_cron?: string;
  config_schema?: Record<string, unknown>;
}

const ABOUT_PLACEHOLDER = `Examples:

"We sell workflow software to logistics companies; cuts scheduling time in half. Buyers are ops managers. Find companies that fit and draft outreach."

"Find B2B SaaS companies hiring GTM roles, draft outreach to founders"

"Track real estate listings under $500k in Boulder; flag new ones to me"

"Monitor competitors' product launches and write summary briefs"

"Recruit talent partners for early-stage AI startups"`;

// Step keys the server emits, paired with a "started" label and (for steps
// that have one) the key of the event that marks them done. Rendered as a
// growing checklist while /api/workspaces/create streams progress — real
// steps, not a simulated timer, since the slow part (an LLM call) genuinely
// varies from a couple seconds to much longer.
const STEP_LABEL: Record<string, string> = {
  deriving: 'Reading your description, deriving ICP, tone, and writing rules',
  workspace: 'Creating the workspace',
  drafter: 'Setting up your outbound drafter',
  source: 'Setting up your data source',
};
const STEP_DONE_BY: Record<string, string> = {
  deriving: 'derived',
  workspace: 'workspace_created',
  drafter: 'drafter_created',
};

interface ProgressStep { key: string; label: string; done: boolean }

export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [connectors, setConnectors] = useState<ConnectorMeta[]>([]);
  const [sourceType, setSourceType] = useState<string>('');
  const [sourceName, setSourceName] = useState('');
  const [resendKey, setResendKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<ProgressStep[]>([]);
  const [err, setErr] = useState<string | null>(null);
  // Once the workspace is created we stop here and offer the CSV import step
  // before routing away — this is the one-time moment a new workspace has
  // zero accounts, so it's the right place to bring the first batch in
  // instead of making that a separate trip to Settings later.
  const [createdWorkspaceId, setCreatedWorkspaceId] = useState<string | null>(null);

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
    setProgress([]);
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
      if (!r.body) throw new Error('no response stream');

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let workspaceId: string | null = null;
      let streamErr: string | null = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as { step: string; error?: string; workspace_id?: string };
          if (event.step === 'error') { streamErr = event.error ?? 'create failed'; continue; }
          if (event.step === 'done') { workspaceId = event.workspace_id ?? null; continue; }
          const doneKey = STEP_DONE_BY[event.step];
          const startedKey = Object.entries(STEP_DONE_BY).find(([, v]) => v === event.step)?.[0];
          if (startedKey) {
            // This is a "finished" event for a step already on the list — mark it done.
            setProgress((p) => p.map((s) => (s.key === startedKey ? { ...s, done: true } : s)));
          } else if (STEP_LABEL[event.step]) {
            setProgress((p) => [...p, { key: event.step, label: STEP_LABEL[event.step]!, done: !doneKey }]);
          }
        }
      }

      if (streamErr) { setErr(streamErr); setSubmitting(false); return; }
      if (!workspaceId) { setErr('create failed — no workspace id returned'); setSubmitting(false); return; }
      setProgress((p) => p.map((s) => ({ ...s, done: true })));
      setSubmitting(false);
      setCreatedWorkspaceId(workspaceId);
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

  if (createdWorkspaceId) {
    return (
      <main style={{ padding: '2rem', maxWidth: 640, margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.5rem', marginBottom: '.25rem' }}>Bring in your starting accounts</h1>
        <p style={{ color: 'var(--text-3)', marginBottom: '1.5rem', fontSize: '.9rem' }}>
          Workspace created. Upload a CSV of companies (and contacts, if you have them) to give the agent
          something to work with right away — or skip and add data later from Settings → Import.
        </p>
        <CsvImportPanel workspaceId={createdWorkspaceId} />
        <div style={{ marginTop: '1.5rem', borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
          <button
            onClick={() => router.push(`/workspace/${createdWorkspaceId}`)}
            style={{
              padding: '.65rem 1.25rem', background: '#9ece6a', color: '#000', border: 'none',
              borderRadius: 6, cursor: 'pointer', fontWeight: 500,
            }}
          >
            Continue to workspace →
          </button>
        </div>
      </main>
    );
  }

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
        <div style={helpStyle}>Describe your business and who you sell to, or describe a task you want done continuously — either works. One or two plain sentences. Defaults for tone, ICP, and writing rules get derived from this — you can edit any of them later.</div>
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
        {submitting ? 'working…' : 'Create workspace'}
      </button>

      {progress.length > 0 && (
        <div style={{ marginTop: '1rem', fontSize: '.85rem', fontFamily: 'var(--font-mono, monospace)' }}>
          {progress.map((s) => (
            <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: '.5rem', padding: '.15rem 0', color: s.done ? 'var(--text-3)' : 'var(--text)' }}>
              <span>{s.done ? '✓' : '…'}</span>
              <span>{s.label}{s.done ? '' : '…'}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
