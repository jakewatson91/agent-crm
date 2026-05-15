'use client';

import { useEffect, useState } from 'react';

interface ChainHop {
  fact_id: string;
  fact: {
    predicate: string;
    object_text: string | null;
    confidence: number;
    observed_at: string;
    content_hash: string;
  } | null;
  source_event: {
    id: number;
    action: string;
    actor_kind: string;
    actor_id: string;
    payload: Record<string, unknown>;
    prompt_hash: string | null;
    created_at: string;
  } | null;
}

interface ChainResponse {
  fact_id: string;
  fact: { predicate: string; object_text: string | null } | null;
  hops: ChainHop[];
  hop_count: number;
}

/**
 * Inline expander showing the full provenance chain for a fact_id.
 * Closed by default. Click to fetch + expand. Click again to collapse.
 */
export function CiteChain({ fact_id, label }: { fact_id: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || chain || loading) return;
    setLoading(true);
    fetch(`/api/facts/${fact_id}/chain`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else setChain(j);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, chain, loading, fact_id]);

  return (
    <div style={{ display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        title={`Walk the provenance chain for fact ${fact_id.slice(0, 8)}`}
        style={{
          padding: '2px 8px',
          background: open ? 'var(--accent-blue)' : 'var(--accent-blue-soft)',
          color: open ? 'white' : '#4f6da3',
          border: 'none',
          borderRadius: 999,
          fontSize: '.7rem',
          fontFamily: 'var(--font-mono)',
          cursor: 'pointer',
          marginRight: '.25rem',
        }}
      >
        {label ?? `cite ${fact_id.slice(0, 6)}`}
      </button>
      {open && (
        <div style={{
          display: 'block',
          marginTop: '.4rem',
          padding: '.7rem .85rem',
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderLeft: '3px solid var(--accent-blue)',
          borderRadius: 6,
          fontSize: '.78rem',
          maxWidth: 700,
        }}>
          {loading && <div className="subtle">walking chain…</div>}
          {error && <div style={{ color: 'var(--accent-coral)' }}>✗ {error}</div>}
          {chain && (
            <>
              <div className="subtle" style={{ marginBottom: '.55rem', fontSize: '.72rem' }}>
                {chain.hop_count}-hop provenance chain
              </div>
              {chain.hops.map((h, i) => (
                <div key={h.fact_id} style={{
                  marginBottom: i < chain.hops.length - 1 ? '.6rem' : 0,
                  paddingBottom: i < chain.hops.length - 1 ? '.6rem' : 0,
                  borderBottom: i < chain.hops.length - 1 ? '1px dashed var(--border)' : 'none'
                }}>
                  <div className="mono" style={{ color: '#5a7e5f' }}>
                    hop {i}: <span style={{ color: 'var(--text)' }}>{h.fact?.predicate ?? '?'} = {h.fact?.object_text ?? '?'}</span>
                    {h.fact && <span className="subtle"> (conf={h.fact.confidence})</span>}
                  </div>
                  {h.source_event && (
                    <div className="mono subtle" style={{ marginTop: '.25rem', fontSize: '.72rem', lineHeight: 1.55 }}>
                      ↳ event #{h.source_event.id} · <span style={{ color: 'var(--accent-blue)' }}>{h.source_event.action}</span> by {h.source_event.actor_kind}/{h.source_event.actor_id}<br />
                      <span suppressHydrationWarning>{new Date(h.source_event.created_at).toLocaleString()}</span>
                      {h.source_event.prompt_hash && (
                        <> · prompt {h.source_event.prompt_hash.slice(0, 12)}…</>
                      )}
                    </div>
                  )}
                  {h.fact?.content_hash && (
                    <div className="mono muted" style={{ marginTop: '.2rem', fontSize: '.68rem' }}>
                      content_hash: {h.fact.content_hash.slice(0, 24)}…
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
