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
          padding: '.2rem .5rem',
          background: open ? '#7aa2f7' : '#1f2330',
          color: open ? '#000' : '#7aa2f7',
          border: 'none',
          fontSize: '.7rem',
          cursor: 'pointer',
        }}
      >
        why this?
      </button>
      {open && (
        <div style={{
          marginTop: '.4rem',
          padding: '.6rem .75rem',
          background: '#0a0a0a',
          border: '1px solid #1f2330',
          borderLeft: '3px solid #7aa2f7',
          fontSize: '.78rem',
          maxWidth: 700,
        }}>
          <div style={{ color: '#7aa2f7', fontSize: '.7rem', marginBottom: '.4rem' }}>
            AGENT&apos;S VIEW AT TIME OF WRITING — reconstructed from event log
          </div>
          {loading && <div style={{ color: '#666' }}>replaying…</div>}
          {error && <div style={{ color: '#f7768e' }}>✗ {error}</div>}
          {snap && !loading && (
            <>
              <div style={{ fontSize: '.7rem', color: '#888', marginBottom: '.5rem' }}>
                {factsForEntity.length} active facts on this account · {signalsForEntity.length} signals it saw
              </div>
              {factsForEntity.length === 0 && signalsForEntity.length === 0 && (
                <div style={{ color: '#666', fontStyle: 'italic' }}>
                  No facts or signals existed for this entity at that moment. The agent wrote this from workspace context (About, Constitution, KB) only.
                </div>
              )}
              {factsForEntity.length > 0 && (
                <div style={{ marginBottom: '.5rem' }}>
                  <div style={{ fontSize: '.7rem', color: '#9ece6a', marginBottom: '.2rem' }}>FACTS</div>
                  {factsForEntity.slice(0, 12).map((f) => (
                    <div key={f.id} style={{
                      fontFamily: 'monospace',
                      fontSize: '.72rem',
                      color: citeSet.has(f.id) ? '#9ece6a' : '#888',
                      fontWeight: citeSet.has(f.id) ? 600 : 400,
                    }}>
                      {citeSet.has(f.id) ? '✓ ' : '  '}{f.predicate} = {f.object_text}
                      {citeSet.has(f.id) && <span style={{ color: '#666', fontWeight: 400 }}> (cited)</span>}
                    </div>
                  ))}
                  {factsForEntity.length > 12 && (
                    <div style={{ color: '#666', fontSize: '.7rem' }}>… +{factsForEntity.length - 12} more</div>
                  )}
                </div>
              )}
              {signalsForEntity.length > 0 && (
                <div>
                  <div style={{ fontSize: '.7rem', color: '#7aa2f7', marginBottom: '.2rem' }}>RECENT SIGNALS</div>
                  {signalsForEntity.slice(0, 5).map((s) => (
                    <div key={s.id} style={{ fontSize: '.72rem', color: '#aaa', marginBottom: '.15rem' }}>
                      <span style={{ fontFamily: 'monospace', color: '#888' }}>{s.type}</span>
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
