'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

type AgentBehavior = 'claim_poster' | 'drafter' | 'enricher';

interface Subscription {
  id: string;
  owner_id: string;
  owner_kind: 'agent' | 'user';
  name: string;
  semantic_query: string;
  structured_filter: Record<string, unknown>;
  threshold: number;
  action_on_match: string;
  agent_behavior?: AgentBehavior;
  model?: string | null;
  active: boolean;
  created_at: string;
}

interface ParsedParams {
  name: string;
  owner_id: string;
  semantic_query: string;
  structured_filter: Record<string, unknown>;
  threshold: number;
  action_on_match: string;
  agent_behavior?: AgentBehavior;
  model?: string;
}

export default function AgentsPage() {
  const params = useParams<{ ws: string }>();
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [description, setDescription] = useState('');
  const [parsing, setParsing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<ParsedParams | null>(null);
  const [filterText, setFilterText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [metaTokens, setMetaTokens] = useState<{ input: number; output: number } | null>(null);

  async function load() {
    const res = await fetch(`/api/agents/list?workspace_id=${params.ws}`);
    const j = await res.json();
    setSubs(j.subscriptions ?? []);
  }
  useEffect(() => { load(); }, [params.ws]);

  async function previewParse() {
    if (!description.trim()) return;
    setParsing(true); setError(null); setDraft(null); setMetaTokens(null);
    try {
      const res = await fetch('/api/agents/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'parse failed'); return; }
      setDraft(j.parsed);
      setFilterText(JSON.stringify(j.parsed.structured_filter ?? {}, null, 2));
      setMetaTokens(j.meta_tokens);
    } finally {
      setParsing(false);
    }
  }

  async function confirmCreate() {
    if (!draft) return;
    let parsedFilter: Record<string, unknown>;
    try {
      parsedFilter = JSON.parse(filterText);
      if (typeof parsedFilter !== 'object' || parsedFilter === null || Array.isArray(parsedFilter)) {
        throw new Error('structured_filter must be a JSON object');
      }
    } catch (e) {
      setError(`structured_filter is invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setCreating(true); setError(null);
    try {
      const res = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace_id: params.ws,
          params: { ...draft, structured_filter: parsedFilter },
        }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'create failed'); return; }
      setDescription('');
      setDraft(null);
      setFilterText('');
      setMetaTokens(null);
      await load();
    } finally {
      setCreating(false);
    }
  }

  function discard() {
    setDraft(null);
    setFilterText('');
    setMetaTokens(null);
    setError(null);
  }

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '.5rem', background: '#0a0a0a', color: '#e5e5e5',
    border: '1px solid #1f1f1f', fontFamily: 'inherit', fontSize: '.85rem',
  };
  const labelStyle: React.CSSProperties = { fontSize: '.75rem', color: '#888', marginBottom: '.25rem', display: 'block' };

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Agents</h2>
      <p style={{ color: '#666', fontSize: '.9rem' }}>
        Each row is a saved filter rule. Describe a new agent in plain English, review what the meta-agent
        produced, edit anything that&apos;s wrong, then create.
      </p>

      <div style={{ marginTop: '1.5rem', padding: '1rem', border: '1px solid #1f1f1f' }}>
        <label style={labelStyle}>describe a new agent</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder='e.g. "watch X posts from companies in our ICP"'
          style={inputStyle}
        />
        <div style={{ marginTop: '.75rem', display: 'flex', gap: '.5rem' }}>
          <button
            onClick={previewParse}
            disabled={parsing || !description.trim() || draft !== null}
            style={{
              padding: '.5rem 1rem', background: '#7aa2f7', color: '#000',
              border: 'none', cursor: 'pointer',
              opacity: parsing || !description.trim() || draft !== null ? 0.4 : 1,
            }}
          >
            {parsing ? 'parsing…' : 'preview'}
          </button>
          {draft && (
            <button onClick={discard} style={{ padding: '.5rem 1rem', background: '#1f1f1f', color: '#e5e5e5', border: 'none', cursor: 'pointer' }}>
              discard
            </button>
          )}
        </div>

        {error && (
          <div style={{ marginTop: '.75rem', color: '#f7768e', fontSize: '.85rem' }}>✗ {error}</div>
        )}

        {draft && (
          <div style={{ marginTop: '1.25rem', padding: '.75rem', background: '#0a0a0a', border: '1px solid #1f1f1f' }}>
            <div style={{ fontSize: '.8rem', color: '#999', marginBottom: '.75rem' }}>
              meta-agent draft — edit any field, then confirm.
              {metaTokens && <span style={{ color: '#666' }}> · {metaTokens.input}in / {metaTokens.output}out tokens</span>}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem' }}>
              <div>
                <label style={labelStyle}>owner_id</label>
                <input
                  value={draft.owner_id}
                  onChange={(e) => setDraft({ ...draft, owner_id: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>name</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ marginTop: '.75rem' }}>
              <label style={labelStyle}>semantic_query (used for vector matching)</label>
              <textarea
                value={draft.semantic_query}
                onChange={(e) => setDraft({ ...draft, semantic_query: e.target.value })}
                rows={2}
                style={inputStyle}
              />
            </div>

            <div style={{ marginTop: '.75rem', display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '.75rem' }}>
              <div>
                <label style={labelStyle}>structured_filter (JSON object)</label>
                <textarea
                  value={filterText}
                  onChange={(e) => setFilterText(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                />
              </div>
              <div>
                <label style={labelStyle}>threshold (0–1)</label>
                <input
                  type="number" step="0.05" min={0} max={1}
                  value={draft.threshold}
                  onChange={(e) => setDraft({ ...draft, threshold: parseFloat(e.target.value) })}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>action_on_match</label>
                <input
                  value={draft.action_on_match}
                  onChange={(e) => setDraft({ ...draft, action_on_match: e.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ marginTop: '.75rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.75rem' }}>
              <div>
                <label style={labelStyle}>agent behavior</label>
                <select
                  value={draft.agent_behavior ?? 'claim_poster'}
                  onChange={(e) => setDraft({ ...draft, agent_behavior: e.target.value as AgentBehavior })}
                  style={inputStyle}
                >
                  <option value="claim_poster">claim_poster — 1-2 sentence claim</option>
                  <option value="drafter">drafter — touch_draft email</option>
                  <option value="enricher">enricher — extract facts from signal</option>
                </select>
              </div>
              <div>
                <label style={labelStyle}>model</label>
                <input
                  value={draft.model ?? ''}
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  placeholder="gpt-4o-mini, deepseek/deepseek-v4-flash, anthropic/claude-sonnet-4.5, ..."
                  style={inputStyle}
                />
              </div>
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', gap: '.5rem' }}>
              <button
                onClick={confirmCreate}
                disabled={creating}
                style={{
                  padding: '.5rem 1rem', background: '#9ece6a', color: '#000',
                  border: 'none', cursor: 'pointer', opacity: creating ? 0.4 : 1,
                }}
              >
                {creating ? 'creating…' : 'create'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div style={{ marginTop: '2rem' }}>
        <div style={{ fontSize: '.85rem', color: '#999', marginBottom: '.75rem' }}>
          {subs.length} active subscription{subs.length === 1 ? '' : 's'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          {subs.map((s) => (
            <div key={s.id} style={{ padding: '.75rem 1rem', border: '1px solid #1f1f1f', background: s.active ? 'transparent' : '#0a0a0a' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div style={{ fontSize: '.95rem', color: '#e5e5e5', fontFamily: 'monospace' }}>{s.owner_id}</div>
                <div style={{ fontSize: '.75rem', color: '#666' }}>thr={s.threshold} · {s.action_on_match} · {s.agent_behavior ?? 'claim_poster'} · {s.model ?? 'default'} · {s.active ? 'active' : 'paused'}</div>
              </div>
              <div style={{ fontSize: '.8rem', color: '#888', marginTop: '.25rem' }}>{s.name}</div>
              <div style={{ fontSize: '.85rem', color: '#aaa', marginTop: '.5rem', fontStyle: 'italic' }}>&ldquo;{s.semantic_query}&rdquo;</div>
              {Object.keys(s.structured_filter ?? {}).length > 0 && (
                <div style={{ fontSize: '.75rem', color: '#666', marginTop: '.5rem', fontFamily: 'monospace' }}>
                  filter: {JSON.stringify(s.structured_filter)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
