'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CiteChain } from './CiteChain';
import { lowConfLabel } from '../_lib/confidence';
import { humanizePredicate } from '../_lib/labels';

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    const combined = host + path;
    return combined.length > 50 ? combined.slice(0, 47) + '…' : combined;
  } catch {
    return url.length > 50 ? url.slice(0, 47) + '…' : url;
  }
}

interface CitedFact {
  id: string;
  predicate: string;
  object_text: string | null;
  object_entity: string | null;
  object_entity_name: string | null;
  confidence: number;
  observed_at: string;
  source_event_id: number | null;
  source_signal: { source_name: string | null; source_url: string | null } | null;
}

/**
 * "Why this?" — the agent's audit panel for a single post.
 *
 * Shows the reasoning the agent wrote when it produced the post, the facts it
 * actually cited (with a click-through to walk each fact's provenance chain),
 * and the source event metadata. Intentionally NOT a fact dump — the full
 * "everything the agent knew at time T" view lives in the audit slider at the
 * bottom of the entity page.
 */
export function WhyThis({
  postId,
  workspace_id,
  entity_id,
  ts,
  reasoning,
  cites,
}: {
  postId: string;
  workspace_id: string;
  entity_id: string;
  ts: string;
  reasoning: string | null;
  cites: string[];
}) {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<CitedFact[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || facts || loading || cites.length === 0) return;
    setLoading(true);
    fetch(`/api/facts/batch?ids=${cites.join(',')}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.error) setError(j.error);
        else setFacts(j.facts ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, facts, loading, cites]);

  return (
    <div style={{ display: 'inline-block' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Show the agent's reasoning and what it cited"
        style={{
          padding: '2px 10px',
          background: open ? 'var(--accent-blue)' : 'var(--accent-blue-soft)',
          color: open ? 'white' : 'var(--badge-blue-fg)',
          border: 'none',
          borderRadius: 999,
          fontSize: '.7rem',
          fontWeight: 500,
          cursor: 'pointer',
        }}
      >
        why this?
      </button>
      {open && (
        <div style={{
          marginTop: '.4rem',
          padding: '.7rem .85rem',
          background: 'var(--panel-2)',
          border: '1px solid var(--border)',
          borderLeft: '3px solid var(--accent-blue)',
          borderRadius: 6,
          fontSize: '.78rem',
          maxWidth: 700,
        }}>
          <div style={{ color: 'var(--badge-blue-fg)', fontSize: '.68rem', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            agent&apos;s reasoning
          </div>
          {reasoning ? (
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5, marginBottom: '.6rem', color: 'var(--text)' }}>
              {reasoning}
            </div>
          ) : (
            <div className="muted" style={{ fontStyle: 'italic', marginBottom: '.6rem' }}>
              No reasoning recorded for this post.
            </div>
          )}

          <div style={{ color: 'var(--badge-green-fg)', fontSize: '.68rem', marginBottom: '.3rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            cited facts · {cites.length}
          </div>
          {cites.length === 0 && (
            <div className="muted" style={{ fontStyle: 'italic' }}>
              The agent cited no facts on this post.
            </div>
          )}
          {loading && <div className="subtle">loading cited facts…</div>}
          {error && <div style={{ color: 'var(--accent-coral)' }}>✗ {error}</div>}
          {facts && facts.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem' }}>
              {facts.map((f) => (
                <div key={f.id} className="mono" style={{ fontSize: '.74rem', display: 'flex', gap: '.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--badge-green-fg)' }}>✓</span>
                  <span style={{ color: 'var(--text)' }}>
                    {humanizePredicate(f.predicate)} ={' '}
                    {f.object_entity && f.object_entity_name ? (
                      <Link href={`/workspace/${workspace_id}/entities/${f.object_entity}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
                        {f.object_entity_name}
                      </Link>
                    ) : (
                      f.object_text ?? '—'
                    )}
                  </span>
                  {lowConfLabel(f.confidence) && (
                    <span className="muted" style={{ fontSize: '.66rem', color: 'var(--accent-coral)' }}>
                      {lowConfLabel(f.confidence)}
                    </span>
                  )}
                  {f.source_signal?.source_url && (
                    <a
                      href={f.source_signal.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: 'var(--accent-blue)', fontSize: '.7rem', textDecoration: 'underline' }}
                      title={f.source_signal.source_url}
                    >
                      ↗ {prettyUrl(f.source_signal.source_url)}
                    </a>
                  )}
                  <CiteChain fact_id={f.id} label="chain" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
