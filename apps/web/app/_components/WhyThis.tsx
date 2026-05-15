'use client';

import { useState } from 'react';

interface ReplaySnapshot {
  facts?: Array<{ id: string; predicate: string; object_text: string; subject_entity: string; observed_at: string; confidence: number }>;
  signals?: Array<{ id: string; type: string; entity_id: string; body_for_embedding?: string }>;
  entities?: Array<{ id: string; name: string; attributes: Record<string, unknown> }>;
}

/**
 * "Why this?" — opens a side panel showing the agent's snapshot at the moment a
 * post was written. Uses replay_to(post.created_at - epsilon) so the user sees
 * exactly what facts/signals existed when the agent decided to write this post.
 *
 * This is the everyday surface for replay. The user thinks "show me why" —
 * they don't think about replay as a feature.
 */
export function WhyThis({
  workspace_id,
  entity_id,
  ts,
  cites,
}: {
  workspace_id: string;
  entity_id: string;
  ts: string;          // post created_at — we replay to just before this moment
  cites?: string[];    // fact_ids the post claimed to cite, for quick highlight
}) {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<ReplaySnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchSnapshot() {
    setLoading(true); setError(null);
    try {
      // Replay to 1ms before the post was written — that's the state the agent
      // saw at decision time. Replaying to created_at exactly would include the
      // post's own causal events.
      const replayTs = new Date(Date.parse(ts) - 1).toISOString();
      const res = await fetch('/api/primitives/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id, ts: replayTs }),
      });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? 'replay failed'); return; }
      setSnap(j);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    if (!open && !snap) fetchSnapshot();
    setOpen(!open);
  }

  const citeSet = new Set(cites ?? []);
  const factsForEntity = (snap?.facts ?? []).filter((f) => f.subject_entity === entity_id);
  const signalsForEntity = (snap?.signals ?? []).filter((s) => s.entity_id === entity_id);

  return (
    <div style={{ display: 'inline-block' }}>
      <button
        onClick={toggle}
        title="Show what the agent knew when it wrote this"
        style={{
          padding: '2px 10px',
          background: open ? 'var(--accent-blue)' : 'var(--accent-blue-soft)',
          color: open ? 'white' : '#4f6da3',
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
          <div style={{ color: '#4f6da3', fontSize: '.68rem', marginBottom: '.5rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
            agent&apos;s view at time of writing
          </div>
          {loading && <div className="subtle">replaying…</div>}
          {error && <div style={{ color: 'var(--accent-coral)' }}>✗ {error}</div>}
          {snap && !loading && (
            <>
              <div className="subtle" style={{ fontSize: '.72rem', marginBottom: '.5rem' }}>
                {factsForEntity.length} active facts on this account · {signalsForEntity.length} signals it saw
              </div>
              {factsForEntity.length === 0 && signalsForEntity.length === 0 && (
                <div className="muted" style={{ fontStyle: 'italic' }}>
                  No facts or signals existed for this entity at that moment. The agent wrote this from workspace context only.
                </div>
              )}
              {factsForEntity.length > 0 && (
                <div style={{ marginBottom: '.55rem' }}>
                  <div style={{ fontSize: '.68rem', color: '#5a7e5f', marginBottom: '.25rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>facts</div>
                  {factsForEntity.slice(0, 12).map((f) => (
                    <div key={f.id} className="mono" style={{
                      fontSize: '.72rem',
                      color: citeSet.has(f.id) ? '#5a7e5f' : 'var(--text-2)',
                      fontWeight: citeSet.has(f.id) ? 600 : 400,
                    }}>
                      {citeSet.has(f.id) ? '✓ ' : '  '}{f.predicate} = {f.object_text}
                      {citeSet.has(f.id) && <span className="muted" style={{ fontWeight: 400 }}> (cited)</span>}
                    </div>
                  ))}
                  {factsForEntity.length > 12 && (
                    <div className="muted" style={{ fontSize: '.7rem' }}>… +{factsForEntity.length - 12} more</div>
                  )}
                </div>
              )}
              {signalsForEntity.length > 0 && (
                <div>
                  <div style={{ fontSize: '.68rem', color: '#4f6da3', marginBottom: '.25rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>recent signals</div>
                  {signalsForEntity.slice(0, 5).map((s) => (
                    <div key={s.id} style={{ fontSize: '.72rem', color: 'var(--text-2)', marginBottom: '.15rem' }}>
                      <span className="mono subtle">{s.type}</span>
                      {s.body_for_embedding && <> · {s.body_for_embedding.slice(0, 100)}…</>}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
