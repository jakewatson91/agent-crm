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

const KIND_BADGE: Record<TimelineItem['kind'], { color: string; cls: string; label: string }> = {
  signal: { color: 'var(--accent-blue)',   cls: 'badge-blue',   label: 'signal' },
  fact:   { color: 'var(--accent-green)',  cls: 'badge-green',  label: 'fact' },
  post:   { color: 'var(--accent-amber)',  cls: 'badge-amber',  label: 'post' },
  gate:   { color: 'var(--accent-coral)',  cls: 'badge-coral',  label: 'gate' },
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '.5rem', marginBottom: '.5rem' }}>
        <h2 style={{ marginTop: 0, marginBottom: 0 }}>{data.entity?.name ?? data.channel.title}</h2>
        <div className="subtle mono" style={{ fontSize: '.75rem' }}>
          {data.counts.signals} signals · {data.counts.facts} facts · {data.counts.posts} posts · {data.counts.gates} gates
        </div>
      </div>

      {/* Audit slider — collapsed by default. The everyday surface is the "why this?"
          button per post below; the slider is for power-user audit. */}
      {minTs && maxTs && (
        <details style={{ marginTop: '.75rem' }}>
          <summary className="subtle" style={{ cursor: 'pointer', fontSize: '.75rem', padding: '.4rem 0' }}>
            audit · time-travel slider
          </summary>
          <div className="card" style={{ marginTop: '.5rem', padding: '.7rem .9rem' }}>
            <div className="subtle" style={{ fontSize: '.72rem', marginBottom: '.55rem' }}>
              Drag to reconstruct workspace state at any past point. For per-post reasoning, use the &ldquo;why this?&rdquo; buttons below.
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '.75rem' }}>
              <input
                type="range"
                min={Date.parse(minTs)}
                max={Date.parse(maxTs)}
                step={1000}
                value={replayTs ? Date.parse(replayTs) : Date.parse(maxTs)}
                onChange={(e) => setReplayTs(new Date(parseInt(e.target.value, 10)).toISOString())}
                style={{ flex: 1 }}
              />
              <div className="mono" style={{ fontSize: '.75rem', color: 'var(--accent-blue)', whiteSpace: 'nowrap', minWidth: 180 }}>
                {replayTs ? <Timestamp value={replayTs} /> : 'now'}
              </div>
              {replayTs && (
                <button onClick={() => setReplayTs(null)} style={{ padding: '.25rem .6rem', background: 'var(--panel-2)', color: 'var(--text)', border: '1px solid var(--border)', fontSize: '.72rem' }}>
                  back to now
                </button>
              )}
            </div>
            {replayTs && (
              <div style={{ marginTop: '.6rem', padding: '.55rem .8rem', background: 'var(--panel-2)', borderLeft: '3px solid var(--accent-blue)', borderRadius: 4, fontSize: '.78rem' }}>
                {replayLoading ? <div className="subtle">replaying…</div> : (
                  <>
                    <div className="subtle" style={{ fontSize: '.72rem', marginBottom: '.4rem' }}>
                      {replayActiveFacts.length} active facts at this timestamp
                    </div>
                    {replayActiveFacts.slice(0, 10).map((f) => (
                      <div key={f.id} className="mono" style={{ fontSize: '.72rem', color: '#5a7e5f' }}>
                        {f.predicate} = {f.object_text}
                      </div>
                    ))}
                    {replayActiveFacts.length > 10 && <div className="muted" style={{ fontSize: '.7rem', marginTop: '.25rem' }}>… +{replayActiveFacts.length - 10} more</div>}
                  </>
                )}
              </div>
            )}
          </div>
        </details>
      )}

      {data.entity?.attributes && Object.keys(data.entity.attributes).length > 0 && (
        <div className="card" style={{ marginTop: '1rem', padding: '.7rem .9rem' }}>
          <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.3rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>attributes</div>
          <pre className="mono subtle" style={{ margin: 0, fontSize: '.72rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(data.entity.attributes, null, 2)}
          </pre>
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <div className="subtle" style={{ fontSize: '.78rem', marginBottom: '.75rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>activity timeline</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
          {data.items.map((item) => {
            const dimmed = Date.parse(item.ts) > replayCutoff;
            const badge = KIND_BADGE[item.kind];
            return (
              <div
                key={`${item.kind}-${item.id}`}
                className="card"
                style={{
                  padding: '.6rem .8rem',
                  borderLeft: `3px solid ${badge.color}`,
                  opacity: dimmed ? 0.4 : 1,
                  fontSize: '.85rem',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '.75rem', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span className={`badge ${badge.cls}`}>{badge.label}</span>
                    <span>{item.summary}</span>
                  </div>
                  <span className="muted mono" style={{ fontSize: '.7rem' }}>
                    <Timestamp value={item.ts} />
                  </span>
                </div>

                {item.kind === 'post' && item.detail.body && (
                  <div style={{ marginTop: '.45rem', whiteSpace: 'pre-wrap', color: 'var(--text)', fontSize: '.85rem', lineHeight: 1.55 }}>
                    {item.detail.body}
                  </div>
                )}
                {item.kind === 'signal' && item.detail.body && (
                  <div className="subtle" style={{ marginTop: '.3rem', fontSize: '.78rem' }}>
                    {String(item.detail.body).slice(0, 220)}
                    {item.detail.item_url && (
                      <> · <a href={String(item.detail.item_url)} target="_blank" rel="noreferrer">source ↗</a></>
                    )}
                  </div>
                )}
                {item.kind === 'fact' && item.detail.superseded && (
                  <div className="muted" style={{ marginTop: '.2rem', fontSize: '.72rem', fontStyle: 'italic' }}>(superseded by a later fact)</div>
                )}

                {item.kind === 'post' && (
                  <div style={{ marginTop: '.45rem', display: 'flex', flexWrap: 'wrap', gap: '.4rem', alignItems: 'center' }}>
                    <WhyThis
                      workspace_id={params.ws}
                      entity_id={data.channel.account_entity_id}
                      ts={item.ts}
                      cites={(item.detail.cites as string[]) ?? []}
                    />
                    {Array.isArray(item.detail.cites) && (item.detail.cites as string[]).length > 0 && (
                      <>
                        <span className="subtle" style={{ fontSize: '.7rem' }}>cites:</span>
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
