'use client';

import { useEffect, useState } from 'react';
import { lowConfLabel } from '../_lib/confidence';
import { humanizePredicate } from '../_lib/labels';

// Who took the action, in plain words. The raw actor_kind/actor_id stays in the
// per-hop "raw" toggle for a developer.
function actorWord(kind: string | null | undefined): string {
  if (kind === 'agent') return 'the agent';
  if (kind === 'human' || kind === 'user') return 'a person';
  if (kind === 'system') return 'the system';
  return kind ?? 'unknown';
}

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
  signal: {
    id: string;
    type: string;
    body_excerpt: string | null;
    source_name: string | null;
    source_url: string | null;
    observed_at: string;
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
        title="Show where this came from"
        style={{
          padding: '2px 8px',
          background: open ? 'var(--accent-blue)' : 'var(--accent-blue-soft)',
          color: open ? 'white' : 'var(--badge-blue-fg)',
          border: 'none',
          borderRadius: 999,
          fontSize: '.7rem',
          cursor: 'pointer',
          marginRight: '.25rem',
        }}
      >
        {label ?? 'trace'}
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
                where this came from{chain.hop_count > 1 ? ` · ${chain.hop_count} steps` : ''}
              </div>
              {chain.hops.map((h, i) => (
                <div key={h.fact_id} style={{
                  marginBottom: i < chain.hops.length - 1 ? '.6rem' : 0,
                  paddingBottom: i < chain.hops.length - 1 ? '.6rem' : 0,
                  borderBottom: i < chain.hops.length - 1 ? '1px dashed var(--border)' : 'none'
                }}>
                  <div style={{ color: 'var(--badge-green-fg)' }}>
                    <span style={{ color: 'var(--text)' }}>{h.fact ? humanizePredicate(h.fact.predicate) : '?'} = {h.fact?.object_text ?? '?'}</span>
                    {h.fact && lowConfLabel(h.fact.confidence) && (
                      <span style={{ color: 'var(--accent-coral)' }}> · {lowConfLabel(h.fact.confidence)}</span>
                    )}
                  </div>
                  {h.source_event && (
                    <div className="subtle" style={{ marginTop: '.25rem', fontSize: '.72rem' }}>
                      noted by {actorWord(h.source_event.actor_kind)} · <span suppressHydrationWarning>{new Date(h.source_event.created_at).toLocaleString()}</span>
                    </div>
                  )}
                  {h.signal && (
                    <div style={{ marginTop: '.4rem', padding: '.45rem .6rem', background: 'var(--panel)', borderLeft: '2px solid var(--badge-green-fg)', borderRadius: 4 }}>
                      <div className="mono" style={{ fontSize: '.7rem', color: 'var(--badge-green-fg)', marginBottom: '.2rem' }}>
                        ↳ from signal
                      </div>
                      {h.signal.body_excerpt && (
                        <div style={{ fontSize: '.75rem', color: 'var(--text)', lineHeight: 1.45, marginBottom: '.3rem' }}>
                          “{h.signal.body_excerpt}{h.signal.body_excerpt.length >= 280 ? '…' : ''}”
                        </div>
                      )}
                      <div className="mono subtle" style={{ fontSize: '.68rem' }}>
                        {h.signal.source_name && <>source: {h.signal.source_name} · </>}
                        {h.signal.source_url && (
                          <a href={h.signal.source_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-blue)' }}>
                            open link ↗
                          </a>
                        )}
                        {' · '}
                        <span suppressHydrationWarning>{new Date(h.signal.observed_at).toLocaleString()}</span>
                      </div>
                    </div>
                  )}
                  {(h.source_event || h.fact?.content_hash) && (
                    <details style={{ marginTop: '.3rem' }}>
                      <summary className="subtle mono" style={{ cursor: 'pointer', fontSize: '.66rem' }}>raw</summary>
                      <div className="mono muted" style={{ marginTop: '.2rem', fontSize: '.66rem', lineHeight: 1.5, overflowWrap: 'anywhere' }}>
                        {h.source_event && (
                          <>event #{h.source_event.id} · {h.source_event.action} · {h.source_event.actor_kind}/{h.source_event.actor_id}<br /></>
                        )}
                        {h.source_event?.prompt_hash && <>prompt_hash {h.source_event.prompt_hash}<br /></>}
                        {h.fact?.content_hash && <>content_hash {h.fact.content_hash}</>}
                      </div>
                    </details>
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
