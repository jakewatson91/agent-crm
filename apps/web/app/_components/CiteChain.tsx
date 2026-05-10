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
          padding: '.15rem .4rem',
          background: open ? '#7aa2f7' : '#1f2330',
          color: open ? '#000' : '#7aa2f7',
          border: 'none',
          fontSize: '.7rem',
          fontFamily: 'monospace',
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
          padding: '.6rem .75rem',
          background: '#0a0a0a',
          border: '1px solid #1f2330',
          borderLeft: '3px solid #7aa2f7',
          fontSize: '.78rem',
          maxWidth: 700,
        }}>
          {loading && <div style={{ color: '#666' }}>walking chain…</div>}
          {error && <div style={{ color: '#f7768e' }}>✗ {error}</div>}
          {chain && (
            <>
              <div style={{ color: '#888', marginBottom: '.5rem', fontSize: '.7rem' }}>
                {chain.hop_count}-hop provenance chain
              </div>
              {chain.hops.map((h, i) => (
                <div key={h.fact_id} style={{ marginBottom: i < chain.hops.length - 1 ? '.6rem' : 0, paddingBottom: i < chain.hops.length - 1 ? '.6rem' : 0, borderBottom: i < chain.hops.length - 1 ? '1px dashed #1f2330' : 'none' }}>
                  <div style={{ fontFamily: 'monospace', color: '#9ece6a' }}>
                    hop {i}: <span style={{ color: '#e5e5e5' }}>{h.fact?.predicate ?? '?'} = {h.fact?.object_text ?? '?'}</span>
                    {h.fact && <span style={{ color: '#666' }}> (conf={h.fact.confidence})</span>}
                  </div>
                  {h.source_event && (
                    <div style={{ marginTop: '.25rem', color: '#999', fontSize: '.72rem', fontFamily: 'monospace', lineHeight: 1.55 }}>
                      ↳ event #{h.source_event.id} · <span style={{ color: '#7aa2f7' }}>{h.source_event.action}</span> by {h.source_event.actor_kind}/{h.source_event.actor_id}<br />
                      <span suppressHydrationWarning>{new Date(h.source_event.created_at).toLocaleString()}</span>
                      {h.source_event.prompt_hash && (
                        <> · prompt {h.source_event.prompt_hash.slice(0, 12)}…</>
                      )}
                    </div>
                  )}
                  {h.fact?.content_hash && (
                    <div style={{ marginTop: '.2rem', color: '#555', fontSize: '.68rem', fontFamily: 'monospace' }}>
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
