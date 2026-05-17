'use client';

/**
 * Connector wizard for custom_http connectors.
 *
 * Four steps:
 *   1. Name + URL + auth headers (and optional method/body for POST)
 *   2. Test fetch — show the raw response so the user can confirm shape
 *   3. Describe what to extract — LLM generates the spec (response_path,
 *      extraction prompt, signal_type)
 *   4. Preview the spec → user edits inline → save
 *
 * Saves to sources table via /api/connectors/create. After save, the
 * dispatcher cron picks the source up on its next tick.
 */

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

type Step = 1 | 2 | 3 | 4;

interface Spec {
  fetch: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    response_path?: string;
  };
  extract: {
    system_prompt: string;
    batch_size?: number;
    model?: string;
  };
  signal?: { type?: string; magnitude?: number };
  dedup?: { since_hours?: number; item_id_path?: string };
}

const SCHEDULES = [
  { label: 'Every hour',       value: '0 * * * *' },
  { label: 'Every 6 hours',    value: '0 */6 * * *' },
  { label: 'Daily (6am UTC)',  value: '0 6 * * *' },
  { label: 'Weekly (Mon 6am)', value: '0 6 * * 1' },
];

export default function NewConnectorPage() {
  const params = useParams() as { ws: string };
  const router = useRouter();

  const [step, setStep] = useState<Step>(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Step 1
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [method, setMethod] = useState<'GET' | 'POST'>('GET');
  const [headersText, setHeadersText] = useState('');
  const [bodyText, setBodyText] = useState('');

  // Step 2
  const [sampleResponse, setSampleResponse] = useState<unknown>(null);
  const [sampleRaw, setSampleRaw] = useState<string | null>(null);

  // Step 3
  const [description, setDescription] = useState('');
  const [rationale, setRationale] = useState<string | null>(null);

  // Step 4
  const [spec, setSpec] = useState<Spec | null>(null);
  const [schedule, setSchedule] = useState('0 */6 * * *');

  function parseHeaders(): Record<string, string> {
    if (!headersText.trim()) return {};
    try { return JSON.parse(headersText); } catch { return {}; }
  }

  async function testFetch() {
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/connectors/test-fetch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method, headers: parseHeaders(), body: bodyText || undefined }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'fetch failed'); return; }
      if (j.json) { setSampleResponse(j.json); setSampleRaw(null); }
      else { setSampleResponse(null); setSampleRaw(j.raw_text ?? null); setErr(`Response is not JSON: ${j.parse_error ?? 'unknown'}`); }
      setStep(2);
    } finally { setBusy(false); }
  }

  async function generateSpec() {
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/connectors/generate-spec', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url, method, headers: parseHeaders(), body: bodyText || undefined,
          sample_response: sampleResponse, description,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'spec generation failed'); return; }
      setSpec(j.spec as Spec);
      setRationale(j.rationale ?? null);
      setStep(4);
    } finally { setBusy(false); }
  }

  async function save() {
    if (!spec) return;
    setErr(null); setBusy(true);
    try {
      const r = await fetch('/api/connectors/create', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: params.ws, name: name.trim(), spec, schedule_cron: schedule, active: true,
        }),
      });
      const j = await r.json();
      if (!r.ok) { setErr(j.error ?? 'save failed'); return; }
      router.push(`/workspace/${params.ws}/settings`);
    } finally { setBusy(false); }
  }

  // ---- style tokens ----
  const labelStyle: React.CSSProperties = { fontSize: '.85rem', color: 'var(--text-2)', marginBottom: '.25rem', display: 'block', fontWeight: 500 };
  const helpStyle: React.CSSProperties = { fontSize: '.75rem', color: 'var(--text-3)', marginBottom: '.5rem' };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '.6rem .75rem', background: 'var(--panel)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit', fontSize: '.9rem',
  };
  const textareaStyle: React.CSSProperties = { ...inputStyle, lineHeight: 1.5, fontFamily: 'JetBrains Mono, monospace', fontSize: '.8rem' };
  const btnPrimary: React.CSSProperties = { padding: '.5rem 1rem', background: 'var(--accent)', color: 'var(--accent-fg)', border: 0, borderRadius: 6, cursor: 'pointer', fontWeight: 500 };
  const btnSecondary: React.CSSProperties = { padding: '.5rem 1rem', background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' };

  return (
    <main style={{ padding: '2rem', maxWidth: 760, margin: '0 auto' }}>
      <div style={{ marginBottom: '1.5rem' }}>
        <a href={`/workspace/${params.ws}/settings`} style={{ color: 'var(--text-3)', fontSize: '.85rem', textDecoration: 'none' }}>← Settings</a>
        <h1 style={{ margin: '.5rem 0', fontSize: '1.5rem' }}>New connector</h1>
        <div style={{ fontSize: '.85rem', color: 'var(--text-3)' }}>
          Step {step} of 4 — {step === 1 ? 'Fetch' : step === 2 ? 'Test response' : step === 3 ? 'Describe' : 'Preview + save'}
        </div>
      </div>

      {err && (
        <div style={{ padding: '.75rem', background: 'rgba(220,80,80,.1)', border: '1px solid rgba(220,80,80,.3)', borderRadius: 6, fontSize: '.85rem', color: 'var(--text)', marginBottom: '1rem' }}>{err}</div>
      )}

      {step === 1 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>Name</label>
            <div style={helpStyle}>Short identifier for this connector. e.g. "hn_ai_mentions" or "zillow_boulder".</div>
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="hn_ai_mentions" />
          </div>
          <div>
            <label style={labelStyle}>URL</label>
            <div style={helpStyle}>Full URL including any query string. Use ${'${env:NAME}'} in headers to pull secrets from environment.</div>
            <input style={inputStyle} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hn.algolia.com/api/v1/search?query=agent+CRM&tags=story" />
          </div>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Method</label>
              <select style={inputStyle} value={method} onChange={(e) => setMethod(e.target.value as 'GET' | 'POST')}>
                <option value="GET">GET</option>
                <option value="POST">POST</option>
              </select>
            </div>
          </div>
          <div>
            <label style={labelStyle}>Headers (JSON, optional)</label>
            <div style={helpStyle}>For auth, paste like {`{"Authorization":"Bearer \${env:MY_API_KEY}"}`}</div>
            <textarea style={{ ...textareaStyle, minHeight: 80 }} value={headersText} onChange={(e) => setHeadersText(e.target.value)} />
          </div>
          {method === 'POST' && (
            <div>
              <label style={labelStyle}>Request body (optional)</label>
              <textarea style={{ ...textareaStyle, minHeight: 80 }} value={bodyText} onChange={(e) => setBodyText(e.target.value)} />
            </div>
          )}
          <div style={{ display: 'flex', gap: '.5rem' }}>
            <button style={btnPrimary} onClick={testFetch} disabled={!url.trim() || busy}>{busy ? 'Fetching…' : 'Test fetch →'}</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>Response preview</label>
            <div style={helpStyle}>Confirm this is what you expected. The wizard will use it to figure out the response path on the next step.</div>
            <pre style={{ ...textareaStyle, maxHeight: 320, overflow: 'auto', whiteSpace: 'pre' }}>
              {sampleResponse ? JSON.stringify(sampleResponse, null, 2).slice(0, 8000) : (sampleRaw ?? '(empty)')}
            </pre>
          </div>
          <div style={{ display: 'flex', gap: '.5rem' }}>
            <button style={btnSecondary} onClick={() => setStep(1)}>← Back</button>
            <button style={btnPrimary} onClick={() => setStep(3)} disabled={!sampleResponse}>Continue →</button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div>
            <label style={labelStyle}>What are you trying to find here?</label>
            <div style={helpStyle}>
              Plain English. What entities do you want to track? What facts about them matter? Examples: "find startups hiring sales people, extract their hiring role and team size" or "track new real estate listings and capture price, square footage, days on market."
            </div>
            <textarea style={{ ...textareaStyle, minHeight: 140 }} value={description} onChange={(e) => setDescription(e.target.value)} placeholder='I want to track... and extract...' />
          </div>
          <div style={{ display: 'flex', gap: '.5rem' }}>
            <button style={btnSecondary} onClick={() => setStep(2)}>← Back</button>
            <button style={btnPrimary} onClick={generateSpec} disabled={!description.trim() || busy}>{busy ? 'Generating…' : 'Generate spec →'}</button>
          </div>
        </div>
      )}

      {step === 4 && spec && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {rationale && (
            <div style={{ padding: '.75rem', background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '.85rem', color: 'var(--text-2)' }}>
              <div style={{ fontWeight: 500, marginBottom: '.25rem', color: 'var(--text)' }}>Why this spec</div>
              {rationale}
            </div>
          )}
          <div>
            <label style={labelStyle}>Response path</label>
            <div style={helpStyle}>Dot-path into the response that holds the array of items. Empty = the response itself is the array.</div>
            <input style={inputStyle} value={spec.fetch.response_path ?? ''} onChange={(e) => setSpec({ ...spec, fetch: { ...spec.fetch, response_path: e.target.value } })} />
          </div>
          <div>
            <label style={labelStyle}>Item-id path</label>
            <div style={helpStyle}>Dot-path on each item to a stable id (used for dedup). Empty = hash the whole item.</div>
            <input style={inputStyle} value={spec.dedup?.item_id_path ?? ''} onChange={(e) => setSpec({ ...spec, dedup: { ...(spec.dedup ?? {}), item_id_path: e.target.value } })} />
          </div>
          <div>
            <label style={labelStyle}>Signal type</label>
            <div style={helpStyle}>Short snake_case identifier the system tags emitted signals with.</div>
            <input style={inputStyle} value={spec.signal?.type ?? ''} onChange={(e) => setSpec({ ...spec, signal: { ...(spec.signal ?? {}), type: e.target.value } })} />
          </div>
          <div>
            <label style={labelStyle}>Extraction prompt</label>
            <div style={helpStyle}>The system prompt the LLM uses to extract entities + facts from each batch. Review carefully — bad prompt = bad facts.</div>
            <textarea style={{ ...textareaStyle, minHeight: 280 }} value={spec.extract.system_prompt} onChange={(e) => setSpec({ ...spec, extract: { ...spec.extract, system_prompt: e.target.value } })} />
          </div>
          <div>
            <label style={labelStyle}>Schedule</label>
            <select style={inputStyle} value={schedule} onChange={(e) => setSchedule(e.target.value)}>
              {SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '.5rem' }}>
            <button style={btnSecondary} onClick={() => setStep(3)}>← Back</button>
            <button style={btnPrimary} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save connector'}</button>
          </div>
        </div>
      )}
    </main>
  );
}
