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

function whenText(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
 * The provenance trace for a fact: a clean vertical rail from the claim on the
 * page down to the actual sentence on the actual page the agent read. Closed by
 * default (a "trace" pill); click to fetch + expand. The raw event ids / hashes
 * stay behind a per-hop "raw" toggle so the default view reads as a story, not
 * a debug dump.
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
    <div style={{ display: 'inline-block', width: open ? '100%' : 'auto' }}>
      <button
        onClick={() => setOpen(!open)}
        title="Show where this came from"
        style={{
          padding: '2px 8px',
          background: open ? 'var(--accent-blue)' : 'var(--accent-blue-soft)',
          color: open ? '#fff' : 'var(--badge-blue-fg)',
          border: 'none',
          borderRadius: 999,
          fontSize: '.7rem',
          cursor: 'pointer',
        }}
      >
        {open ? '× trace' : (label ?? 'trace')}
      </button>

      {open && (
        <div style={{ marginTop: '.5rem', maxWidth: 640 }}>
          {loading && <div className="subtle" style={{ fontSize: '.75rem' }}>walking the trace…</div>}
          {error && <div style={{ color: 'var(--accent-coral)', fontSize: '.78rem' }}>✗ {error}</div>}
          {chain && (
            <div style={{ position: 'relative', paddingLeft: '1.15rem' }}>
              {/* the rail */}
              <div style={{ position: 'absolute', left: 5, top: 6, bottom: 6, width: 2, background: 'var(--border-strong)' }} />
              {chain.hops.map((h, i) => {
                const last = i === chain.hops.length - 1;
                return (
                  <div key={h.fact_id} style={{ position: 'relative', paddingBottom: last ? 0 : '1rem' }}>
                    <TraceDot />
                    <div style={{ fontSize: '.84rem', color: 'var(--text)', lineHeight: 1.5 }}>
                      <span className="subtle">{h.fact ? humanizePredicate(h.fact.predicate) : 'claim'}</span>
                      {h.fact?.object_text ? <> · <span style={{ color: 'var(--text)' }}>{h.fact.object_text}</span></> : null}
                      {h.fact && lowConfLabel(h.fact.confidence) && (
                        <span style={{ color: 'var(--accent-coral)' }}> · {lowConfLabel(h.fact.confidence)}</span>
                      )}
                    </div>
                    {h.source_event && (
                      <div className="subtle" style={{ fontSize: '.73rem', marginTop: '.15rem' }}>
                        noted by {actorWord(h.source_event.actor_kind)} · <span suppressHydrationWarning>{whenText(h.source_event.created_at)}</span>
                      </div>
                    )}

                    {h.signal && (h.signal.body_excerpt || h.signal.source_url) && (
                      <div style={{ marginTop: '.45rem' }}>
                        {h.signal.source_url ? (
                          <a href={h.signal.source_url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: '.74rem', color: 'var(--accent-blue)' }}>
                            {h.signal.source_name ?? h.signal.source_url.replace(/^https?:\/\//, '').split('/')[0]} ↗
                          </a>
                        ) : (
                          h.signal.source_name && <span className="mono subtle" style={{ fontSize: '.74rem' }}>source: {h.signal.source_name}</span>
                        )}
                        {h.signal.body_excerpt && (
                          <div style={{
                            fontFamily: 'var(--font-serif)', fontStyle: 'italic', fontSize: '.88rem',
                            color: 'var(--text-2)', lineHeight: 1.5, marginTop: '.3rem',
                            borderLeft: '2px solid var(--border-strong)', paddingLeft: '.7rem',
                          }}>
                            “{h.signal.body_excerpt}{h.signal.body_excerpt.length >= 280 ? '…' : ''}”
                          </div>
                        )}
                      </div>
                    )}

                    {(h.source_event || h.fact?.content_hash) && (
                      <details style={{ marginTop: '.35rem' }}>
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
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TraceDot() {
  return (
    <span style={{
      position: 'absolute', left: '-1.15rem', top: 4,
      width: 11, height: 11, borderRadius: '50%',
      background: 'var(--panel)', border: '2px solid var(--accent-blue)',
    }} />
  );
}
