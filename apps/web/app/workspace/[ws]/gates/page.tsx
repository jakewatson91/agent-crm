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

  if (loading) return <section><h2 style={{ marginTop: 0 }}>Gates</h2><p style={{ color: '#666' }}>loading…</p></section>;

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
      <p style={{ color: '#666', fontSize: '.9rem' }}>
        Approval queue. Empty is the success state. Items here are exceptions the agent flagged for you.
        For draft posts: copy → paste into your email tool → approve once sent.
      </p>

      {health && (
        <div style={{
          display: 'flex', gap: '.5rem', flexWrap: 'wrap', marginBottom: '1rem',
          padding: '.5rem .75rem', background: '#0a0a0a', border: '1px solid #1f1f1f', fontSize: '.8rem',
        }}>
          <span style={{ color: '#666' }}>system:</span>
          {allHealthy && <span style={{ color: '#9ece6a' }}>✓ all clear</span>}
          {!allHealthy && healthBadges.filter((b) => b.value > 0).map((b) => (
            <span key={b.label} title={b.hint} style={{
              padding: '.1rem .4rem', borderRadius: 3,
              background: '#1f1f1f',
              color: b.value > 5 ? '#f7768e' : '#e0af68',
              border: `1px solid ${b.value > 5 ? '#f7768e33' : '#e0af6833'}`,
            }}>
              {b.label}: {b.value}
            </span>
          ))}
        </div>
      )}
      {gates.length === 0 ? (
        <div style={{ marginTop: '2rem', padding: '2rem', border: '1px dashed #1f1f1f', textAlign: 'center', color: '#444' }}>
          No pending gates.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1.5rem' }}>
          {gates.map((g) => {
            const isDraft = g.post_kind === 'touch_draft';
            return (
              <li key={g.id} style={{ padding: '1rem', border: '1px solid #1f1f1f', marginBottom: '.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div>
                    <div style={{ fontSize: '.85rem' }}>
                      {g.account_title && <span style={{ color: '#7aa2f7' }}>{g.account_title} · </span>}
                      <span style={{ color: '#e5e5e5' }}>{g.policy}</span>
                      {isDraft && <span style={{ marginLeft: '.5rem', padding: '.1rem .4rem', background: '#7aa2f7', color: '#000', fontSize: '.7rem' }}>DRAFT</span>}
                    </div>
                    <div style={{ fontSize: '.75rem', color: '#666', marginTop: '.15rem' }}>
                      {g.requested_by_agent} · <Timestamp value={g.requested_at} />
                    </div>
                  </div>
                </div>

                {g.post_body && (
                  <div style={{
                    marginTop: '.75rem', padding: '.75rem', background: '#0a0a0a',
                    borderLeft: `3px solid ${isDraft ? '#9ece6a' : '#1f1f1f'}`,
                    whiteSpace: 'pre-wrap', fontSize: '.85rem', color: '#ccc', fontFamily: isDraft ? 'inherit' : 'inherit',
                  }}>
                    {g.post_body}
                  </div>
                )}

                {Object.keys(g.condition ?? {}).length > 0 && (
                  <pre style={{ fontSize: '.7rem', color: '#666', marginTop: '.5rem', overflowX: 'auto' }}>
                    {JSON.stringify(g.condition, null, 2)}
                  </pre>
                )}

                <div style={{ marginTop: '.75rem', display: 'flex', gap: '.5rem', alignItems: 'center' }}>
                  {isDraft && g.post_body && (
                    <button
                      onClick={() => copyDraft(g.id, g.post_body!)}
                      style={{ padding: '.4rem .75rem', background: '#1f1f1f', color: '#e5e5e5', border: 'none', cursor: 'pointer', fontSize: '.8rem' }}
                    >
                      {copied === g.id ? '✓ copied' : 'copy draft'}
                    </button>
                  )}
                  <button
                    onClick={() => decide(g.id, 'approve')}
                    disabled={busy === g.id}
                    style={{ padding: '.4rem .75rem', background: '#9ece6a', color: '#000', border: 'none', cursor: 'pointer', fontSize: '.8rem', opacity: busy === g.id ? 0.4 : 1 }}
                  >
                    {busy === g.id ? '…' : isDraft ? 'sent ✓' : 'approve'}
                  </button>
                  <button
                    onClick={() => decide(g.id, 'reject')}
                    disabled={busy === g.id}
                    style={{ padding: '.4rem .75rem', background: '#1f1f1f', color: '#f7768e', border: '1px solid #1f1f1f', cursor: 'pointer', fontSize: '.8rem', opacity: busy === g.id ? 0.4 : 1 }}
                  >
                    reject
                  </button>
                </div>

                {g.post_cites.length > 0 && (
                  <div style={{ marginTop: '.6rem', paddingTop: '.5rem', borderTop: '1px dashed #1f1f1f' }}>
                    <div style={{ fontSize: '.7rem', color: '#888', marginBottom: '.25rem' }}>
                      {g.post_cites.length} cite{g.post_cites.length === 1 ? '' : 's'} — click to walk the source chain:
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.25rem' }}>
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
