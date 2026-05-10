'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { CiteChain } from '../../../../_components/CiteChain';
import { Timestamp } from '../../../../_components/Timestamp';
import { WhyThis } from '../../../../_components/WhyThis';

interface TimelineItem {
  ts: string;
  kind: 'signal' | 'fact' | 'post' | 'gate';
  id: string;
  summary: string;
  detail: Record<string, any>;
}

interface TimelineResponse {
  channel: { id: string; title: string; account_entity_id: string };
  entity: { name: string; attributes: Record<string, unknown>; kind: string } | null;
  items: TimelineItem[];
  counts: { signals: number; facts: number; posts: number; gates: number };
}

interface ReplayResponse {
  facts?: Array<{ id: string; predicate: string; object_text: string; subject_entity: string; observed_at: string }>;
  entities?: Array<{ id: string; name: string; attributes: Record<string, unknown> }>;
  signals?: Array<{ id: string; type: string; entity_id: string }>;
}

const KIND_BADGE: Record<TimelineItem['kind'], { color: string; label: string }> = {
  signal: { color: '#7aa2f7', label: 'SIGNAL' },
  fact:   { color: '#9ece6a', label: 'FACT' },
  post:   { color: '#e0c080', label: 'POST' },
  gate:   { color: '#f7768e', label: 'GATE' },
};

export default function ChannelPage() {
  const params = useParams<{ ws: string; channel: string }>();
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [replayTs, setReplayTs] = useState<string | null>(null);
  const [replayState, setReplayState] = useState<ReplayResponse | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/channels/${params.channel}/timeline`);
      const j = await res.json();
      setData(j);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [params.channel]);

  // When replay timestamp changes, fetch state at that timestamp
  useEffect(() => {
    if (!replayTs) { setReplayState(null); return; }
    setReplayLoading(true);
    fetch('/api/primitives/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: params.ws, ts: replayTs }),
    }).then((r) => r.json())
      .then((j) => setReplayState(j))
      .finally(() => setReplayLoading(false));
  }, [replayTs, params.ws]);

  // Min/max timestamps from the timeline for the slider bounds.
  const { minTs, maxTs } = useMemo(() => {
    if (!data || !data.items.length) return { minTs: null, maxTs: null };
    const ts = data.items.map((i) => Date.parse(i.ts)).filter(Number.isFinite);
    return {
      minTs: new Date(Math.min(...ts)).toISOString(),
      maxTs: new Date(Math.max(...ts)).toISOString(),
    };
  }, [data]);

  const replayCutoff = replayTs ? Date.parse(replayTs) : Infinity;

  if (loading) return <section><h2 style={{ marginTop: 0 }}>loading…</h2></section>;
  if (!data) return <section><h2>not found</h2></section>;

  const replayActiveFacts = replayState?.facts?.filter((f) => f.subject_entity === data.channel.account_entity_id) ?? [];

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '.5rem' }}>
        <h2 style={{ marginTop: 0, marginBottom: 0 }}>{data.entity?.name ?? data.channel.title}</h2>
        <div style={{ fontSize: '.8rem', color: '#666' }}>
          {data.counts.signals} signals · {data.counts.facts} facts · {data.counts.posts} posts · {data.counts.gates} gates
        </div>
      </div>

      {/* Audit slider — collapsed by default. The everyday surface is the "why this?"
          button per post below; the slider is for power-user audit ("show me state at
          March 15") and demos. */}
      {minTs && maxTs && (
        <details style={{ marginTop: '1rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '.75rem', color: '#666', padding: '.4rem 0' }}>
            audit · time-travel slider (compliance / debugging only)
          </summary>
          <div style={{ marginTop: '.5rem', padding: '.6rem .75rem', background: '#0f0f12', border: '1px solid #1f2330' }}>
            <div style={{ fontSize: '.7rem', color: '#888', marginBottom: '.5rem' }}>
              Drag to reconstruct workspace state at any past point. Used for audit (&ldquo;what did the agent see on March 15?&rdquo;) and demoing event-sourcing. For per-post reasoning, use the &ldquo;why this?&rdquo; buttons below.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.75rem' }}>
              <input
                type="range"
                min={Date.parse(minTs)}
                max={Date.parse(maxTs)}
                step={1000}
                value={replayTs ? Date.parse(replayTs) : Date.parse(maxTs)}
                onChange={(e) => setReplayTs(new Date(parseInt(e.target.value, 10)).toISOString())}
                style={{ flex: 1, accentColor: '#7aa2f7' }}
              />
              <div style={{ fontSize: '.75rem', color: '#7aa2f7', whiteSpace: 'nowrap', fontFamily: 'monospace', minWidth: 180 }}>
                {replayTs ? <Timestamp value={replayTs} /> : 'now'}
              </div>
              {replayTs && (
                <button onClick={() => setReplayTs(null)} style={{ padding: '.25rem .5rem', background: '#1f2330', color: '#e5e5e5', border: 'none', cursor: 'pointer', fontSize: '.7rem' }}>
                  back to now
                </button>
              )}
            </div>
            {replayTs && (
              <div style={{ marginTop: '.6rem', padding: '.5rem .75rem', background: '#0a0a0a', borderLeft: '3px solid #7aa2f7', fontSize: '.78rem' }}>
                {replayLoading ? <div style={{ color: '#666' }}>replaying…</div> : (
                  <>
                    <div style={{ fontSize: '.72rem', color: '#888', marginBottom: '.4rem' }}>
                      {replayActiveFacts.length} active facts at this timestamp
                    </div>
                    {replayActiveFacts.slice(0, 10).map((f) => (
                      <div key={f.id} style={{ fontFamily: 'monospace', fontSize: '.72rem', color: '#9ece6a' }}>
                        {f.predicate} = {f.object_text}
                      </div>
                    ))}
                    {replayActiveFacts.length > 10 && <div style={{ color: '#666', fontSize: '.7rem', marginTop: '.25rem' }}>… +{replayActiveFacts.length - 10} more</div>}
                  </>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      {data.entity?.attributes && Object.keys(data.entity.attributes).length > 0 && (
        <div style={{ marginTop: '1rem', padding: '.6rem .75rem', background: '#0a0a0a', border: '1px solid #1f1f1f' }}>
          <div style={{ fontSize: '.7rem', color: '#888', marginBottom: '.25rem' }}>attributes</div>
          <pre style={{ margin: 0, fontSize: '.72rem', color: '#aaa', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(data.entity.attributes, null, 2)}
          </pre>
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <div style={{ fontSize: '.85rem', color: '#888', marginBottom: '.75rem' }}>activity timeline</div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {data.items.map((item) => {
            const dimmed = Date.parse(item.ts) > replayCutoff;
            const badge = KIND_BADGE[item.kind];
            return (
              <div
                key={`${item.kind}-${item.id}`}
                style={{
                  padding: '.55rem .75rem',
                  borderLeft: `3px solid ${badge.color}`,
                  borderBottom: '1px solid #14141a',
                  background: dimmed ? '#0a0a0a' : 'transparent',
                  opacity: dimmed ? 0.35 : 1,
                  fontSize: '.82rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '.75rem' }}>
                  <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '.65rem', color: badge.color, fontWeight: 600 }}>{badge.label}</span>
                    <span style={{ color: '#e5e5e5' }}>{item.summary}</span>
                  </div>
                  <span style={{ fontSize: '.7rem', color: '#666', fontFamily: 'monospace' }}>
                    <Timestamp value={item.ts} />
                  </span>
                </div>

                {item.kind === 'post' && item.detail.body && (
                  <div style={{ marginTop: '.4rem', whiteSpace: 'pre-wrap', color: '#ccc', fontSize: '.8rem' }}>
                    {item.detail.body}
                  </div>
                )}
                {item.kind === 'signal' && item.detail.body && (
                  <div style={{ marginTop: '.3rem', color: '#999', fontSize: '.75rem' }}>
                    {String(item.detail.body).slice(0, 220)}
                    {item.detail.item_url && (
                      <> · <a href={String(item.detail.item_url)} target="_blank" rel="noreferrer" style={{ color: '#7aa2f7' }}>source ↗</a></>
                    )}
                  </div>
                )}
                {item.kind === 'fact' && item.detail.superseded && (
                  <div style={{ marginTop: '.2rem', fontSize: '.7rem', color: '#666', fontStyle: 'italic' }}>(superseded by a later fact)</div>
                )}

                {item.kind === 'post' && (
                  <div style={{ marginTop: '.4rem', display: 'flex', flexWrap: 'wrap', gap: '.4rem', alignItems: 'center' }}>
                    <WhyThis
                      workspace_id={params.ws}
                      entity_id={data.channel.account_entity_id}
                      ts={item.ts}
                      cites={(item.detail.cites as string[]) ?? []}
                    />
                    {Array.isArray(item.detail.cites) && (item.detail.cites as string[]).length > 0 && (
                      <>
                        <span style={{ fontSize: '.7rem', color: '#888' }}>cites:</span>
                        {(item.detail.cites as string[]).map((c) => <CiteChain key={c} fact_id={c} />)}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
