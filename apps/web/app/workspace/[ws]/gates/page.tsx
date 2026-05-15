'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { Timestamp } from '../../../_components/Timestamp';
import { CiteChain } from '../../../_components/CiteChain';

interface Gate {
  id: string;
  requested_by_agent: string;
  policy: string;
  condition: Record<string, unknown>;
  requested_at: string;
  channel_post_id: string | null;
  post_kind: string | null;
  post_body: string | null;
  post_cites: string[];
  account_title: string | null;
  channel_id: string | null;
}

interface Health {
  unmatched_signals: number;
  errored_sources: number;
  stale_gates: number;
  stale_drafts: number;
}

export default function GatesPage() {
  const params = useParams<{ ws: string }>();
  const [gates, setGates] = useState<Gate[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [gRes, hRes] = await Promise.all([
        fetch(`/api/gates/list?workspace_id=${params.ws}`).then((r) => r.json()),
        fetch(`/api/admin/health?workspace_id=${params.ws}`).then((r) => r.json()).catch(() => null),
      ]);
      setGates(gRes.gates ?? []);
      if (hRes && !hRes.error) setHealth(hRes);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [params.ws]);

  async function decide(gate_id: string, decision: 'approve' | 'reject') {
    setBusy(gate_id);
    try {
      const res = await fetch('/api/gates/decide', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: params.ws, gate_id, decision }),
      });
      if (!res.ok) {
        const j = await res.json();
        alert(`decide failed: ${j.error ?? res.status}`);
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function copyDraft(gate_id: string, body: string) {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(gate_id);
      setTimeout(() => setCopied((c) => (c === gate_id ? null : c)), 1500);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = body; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
      setCopied(gate_id);
      setTimeout(() => setCopied((c) => (c === gate_id ? null : c)), 1500);
    }
  }

  if (loading) return <section><h2 style={{ marginTop: 0 }}>Inbox</h2><p className="subtle">loading…</p></section>;

  const healthBadges = health ? [
    { label: 'unmatched signals', value: health.unmatched_signals, hint: '>30m old, no match' },
    { label: 'errored sources', value: health.errored_sources, hint: 'last run failed' },
    { label: 'stale gates', value: health.stale_gates, hint: '>7d undecided' },
    { label: 'stale drafts', value: health.stale_drafts, hint: '>7d, no follow-up' },
  ] : [];
  const allHealthy = health && healthBadges.every((b) => b.value === 0);

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Inbox</h2>
      <p className="subtle" style={{ fontSize: '.88rem' }}>
        Approval queue. Empty is the success state. For draft posts: copy → paste into your email tool → approve once sent.
      </p>

      {health && (
        <div className="card" style={{
          display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center',
          marginBottom: '1rem', padding: '.55rem .85rem', fontSize: '.78rem',
        }}>
          <span className="subtle">system</span>
          {allHealthy && <span className="badge badge-green">✓ all clear</span>}
          {!allHealthy && healthBadges.filter((b) => b.value > 0).map((b) => (
            <span key={b.label} title={b.hint} className={`badge ${b.value > 5 ? 'badge-coral' : 'badge-amber'}`}>
              {b.label}: {b.value}
            </span>
          ))}
        </div>
      )}
      {gates.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-3)', padding: '2rem', borderStyle: 'dashed' }}>
          No pending gates. The agent is handling everything.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
          {gates.map((g) => {
            const isDraft = g.post_kind === 'touch_draft';
            return (
              <li key={g.id} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '.5rem' }}>
                  <div>
                    <div style={{ fontSize: '.92rem', display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                      {g.account_title && <strong>{g.account_title}</strong>}
                      <span className="mono subtle" style={{ fontSize: '.78rem' }}>{g.policy}</span>
                      {isDraft && <span className="badge badge-green">draft</span>}
                    </div>
                    <div className="muted mono" style={{ fontSize: '.72rem', marginTop: '.15rem' }}>
                      {g.requested_by_agent} · <Timestamp value={g.requested_at} />
                    </div>
                  </div>
                </div>

                {g.post_body && (
                  <div
                    style={{
                      marginTop: '.75rem',
                      padding: '.75rem .9rem',
                      background: 'var(--panel-2)',
                      borderLeft: `3px solid ${isDraft ? 'var(--accent-green)' : 'var(--border-strong)'}`,
                      borderRadius: 4,
                      whiteSpace: 'pre-wrap',
                      fontSize: '.85rem',
                      lineHeight: 1.55,
                      fontFamily: isDraft ? 'var(--font-mono)' : 'var(--font-sans)',
                    }}
                  >
                    {g.post_body}
                  </div>
                )}

                {Object.keys(g.condition ?? {}).length > 0 && (
                  <pre className="mono muted" style={{ fontSize: '.7rem', marginTop: '.5rem', overflowX: 'auto' }}>
                    {JSON.stringify(g.condition, null, 2)}
                  </pre>
                )}

                <div style={{ marginTop: '.75rem', display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                  {isDraft && g.post_body && (
                    <button
                      onClick={() => copyDraft(g.id, g.post_body!)}
                      style={{ padding: '.4rem .85rem', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', fontSize: '.8rem' }}
                    >
                      {copied === g.id ? '✓ copied' : 'copy draft'}
                    </button>
                  )}
                  <button
                    onClick={() => decide(g.id, 'approve')}
                    disabled={busy === g.id}
                    style={{ padding: '.4rem .85rem', background: 'var(--accent-green)', color: 'white', border: 'none', fontSize: '.8rem', opacity: busy === g.id ? 0.4 : 1 }}
                  >
                    {busy === g.id ? '…' : isDraft ? 'sent ✓' : 'approve'}
                  </button>
                  <button
                    onClick={() => decide(g.id, 'reject')}
                    disabled={busy === g.id}
                    style={{ padding: '.4rem .85rem', background: 'transparent', color: 'var(--accent-coral)', border: '1px solid var(--accent-coral)', fontSize: '.8rem', opacity: busy === g.id ? 0.4 : 1 }}
                  >
                    reject
                  </button>
                </div>

                {g.post_cites.length > 0 && (
                  <div style={{ marginTop: '.7rem', paddingTop: '.5rem', borderTop: '1px dashed var(--border)' }}>
                    <div className="subtle" style={{ fontSize: '.72rem', marginBottom: '.3rem' }}>
                      {g.post_cites.length} cite{g.post_cites.length === 1 ? '' : 's'} — click to walk the source chain
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.3rem' }}>
                      {g.post_cites.map((fact_id) => <CiteChain key={fact_id} fact_id={fact_id} />)}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
