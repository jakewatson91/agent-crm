'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'next/navigation';
import { CiteChain } from '../../../../_components/CiteChain';
import { Timestamp } from '../../../../_components/Timestamp';
import { WhyThis } from '../../../../_components/WhyThis';
import { DraftActions } from '../../../../_components/DraftActions';

interface GroupedItem {
  id: string;
  ts: string;
  kind: 'claim' | 'decision' | 'touch_draft' | 'gate_request' | 'outcome' | 'system' | 'question';
  body: string;
  reasoning: string | null;
  cites: string[];
  author_id: string;
  dup_count: number;
}

interface Fact {
  id: string;
  predicate: string;
  object_text: string | null;
  confidence: number;
  observed_at: string;
}

interface SummaryResponse {
  channel: { id: string; title: string; account_entity_id: string };
  entity: { name: string; attributes: Record<string, unknown>; kind: string } | null;
  recent_activity: GroupedItem[];
  current_facts: Record<string, Fact[]>;
  history: GroupedItem[];
  counts: { facts_active: number; posts_total: number; recent: number; history: number };
}

interface TimelineItem {
  ts: string;
  kind: 'signal' | 'fact' | 'post' | 'gate';
  id: string;
  summary: string;
  detail: Record<string, unknown>;
}
interface TimelineResponse {
  items: TimelineItem[];
  counts: { signals: number; facts: number; posts: number; gates: number };
}
interface ReplayResponse {
  facts?: Array<{ id: string; predicate: string; object_text: string; subject_entity: string; observed_at: string }>;
}

const KIND_LABEL: Record<GroupedItem['kind'], { label: string; cls: string }> = {
  claim:        { label: 'new info',       cls: 'badge-blue' },
  decision:     { label: 'note',           cls: 'badge-purple' },
  touch_draft:  { label: 'outreach',       cls: 'badge-green' },
  gate_request: { label: 'needs approval', cls: 'badge-coral' },
  outcome:      { label: 'outcome',        cls: 'badge-amber' },
  system:       { label: 'system',         cls: 'badge-mute' },
  question:     { label: 'question',       cls: 'badge-amber' },
};

const FAMILY_LABEL: Record<string, string> = {
  firmographics: 'Firmographics',
  scoring:       'Scoring',
  engagement:    'Engagement',
  other:         'Other',
};

export default function ChannelPage() {
  const params = useParams<{ ws: string; channel: string }>();
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);

  // Audit slider state — kept on /timeline so the existing replay flow works.
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [replayTs, setReplayTs] = useState<string | null>(null);
  const [replayState, setReplayState] = useState<ReplayResponse | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/channels/${params.channel}/summary`)
      .then((r) => r.json())
      .then((j) => setData(j))
      .finally(() => setLoading(false));
  }, [params.channel]);

  // Lazy-load the audit timeline only when the user opens the slider.
  useEffect(() => {
    if (!auditOpen || timeline) return;
    fetch(`/api/channels/${params.channel}/timeline`).then((r) => r.json()).then((j) => setTimeline(j));
  }, [auditOpen, params.channel, timeline]);

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

  const { minTs, maxTs } = useMemo(() => {
    if (!timeline || !timeline.items.length) return { minTs: null, maxTs: null };
    const ts = timeline.items.map((i) => Date.parse(i.ts)).filter(Number.isFinite);
    return {
      minTs: new Date(Math.min(...ts)).toISOString(),
      maxTs: new Date(Math.max(...ts)).toISOString(),
    };
  }, [timeline]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  if (loading) return <section><h2 style={{ marginTop: 0 }}>loading…</h2></section>;
  if (!data) return <section><h2>not found</h2></section>;

  const replayActiveFacts = replayState?.facts?.filter((f) => f.subject_entity === data.channel.account_entity_id) ?? [];
  const families = Object.keys(data.current_facts).sort((a, b) => {
    const order = ['firmographics', 'scoring', 'engagement', 'other'];
    return order.indexOf(a) - order.indexOf(b);
  });

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '.5rem', marginBottom: '.5rem' }}>
        <h2 style={{ marginTop: 0, marginBottom: 0 }}>{data.entity?.name ?? data.channel.title}</h2>
        <div className="subtle mono" style={{ fontSize: '.75rem' }}>
          {data.counts.facts_active} facts · {data.counts.recent} recent · {data.counts.history} historical
        </div>
      </div>

      {data.entity?.attributes && Object.keys(data.entity.attributes).length > 0 && (
        <div className="card" style={{ marginTop: '1rem', padding: '.7rem .9rem' }}>
          <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.3rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>attributes</div>
          <pre className="mono subtle" style={{ margin: 0, fontSize: '.72rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(data.entity.attributes, null, 2)}
          </pre>
        </div>
      )}

      {/* SECTION 1 — Recent activity (last 14d, deduped) */}
      <div style={{ marginTop: '1.5rem' }}>
        <div className="subtle" style={{ fontSize: '.78rem', marginBottom: '.75rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          recent activity · last 14 days
        </div>
        {data.recent_activity.length === 0 ? (
          <div className="card" style={{ padding: '1rem', color: 'var(--text-3)', textAlign: 'center', fontSize: '.85rem' }}>
            Nothing in the last 14 days.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
            {data.recent_activity.map((it) => (
              <ActivityRow
                key={`${it.kind}::${it.ts}::${it.body.slice(0, 32)}`}
                item={it}
                ws={params.ws}
                entity_id={data.channel.account_entity_id}
                expanded={expanded.has(`${it.kind}::${it.ts}`)}
                onToggle={() => toggle(`${it.kind}::${it.ts}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* SECTION 2 — Current facts */}
      <div style={{ marginTop: '1.75rem' }}>
        <div className="subtle" style={{ fontSize: '.78rem', marginBottom: '.75rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
          current facts
        </div>
        {families.length === 0 ? (
          <div className="card" style={{ padding: '1rem', color: 'var(--text-3)', textAlign: 'center', fontSize: '.85rem' }}>
            No facts asserted yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
            {families.map((fam) => (
              <div key={fam} className="card" style={{ padding: '.7rem .9rem' }}>
                <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  {FAMILY_LABEL[fam] ?? fam}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '.2rem' }}>
                  {(data.current_facts[fam] ?? []).map((f) => (
                    <div key={f.id} className="mono" style={{ fontSize: '.78rem', display: 'flex', gap: '.5rem', alignItems: 'baseline' }}>
                      <span style={{ color: 'var(--text-2)', minWidth: 160 }}>{f.predicate}</span>
                      <span style={{ color: 'var(--text)' }}>{f.object_text}</span>
                      <span className="muted mono" style={{ fontSize: '.68rem', marginLeft: 'auto' }}>
                        conf {f.confidence?.toFixed?.(2) ?? '—'} · <Timestamp value={f.observed_at} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SECTION 3 — History (collapsed by default) */}
      <div style={{ marginTop: '1.75rem' }}>
        <button
          onClick={() => setShowHistory((v) => !v)}
          className="subtle"
          style={{
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: '.78rem', textTransform: 'uppercase', letterSpacing: '.06em',
            color: 'var(--text-2)',
          }}
        >
          {showHistory ? '▾' : '▸'} history · {data.history.length} older entries
        </button>
        {showHistory && data.history.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', marginTop: '.75rem' }}>
            {data.history.map((it) => (
              <ActivityRow
                key={`hist::${it.kind}::${it.ts}`}
                item={it}
                ws={params.ws}
                entity_id={data.channel.account_entity_id}
                expanded={expanded.has(`hist::${it.kind}::${it.ts}`)}
                onToggle={() => toggle(`hist::${it.kind}::${it.ts}`)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Audit slider — opt-in. Loads /timeline lazily. */}
      <details style={{ marginTop: '1.5rem' }} onToggle={(e) => setAuditOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="subtle" style={{ cursor: 'pointer', fontSize: '.75rem', padding: '.4rem 0' }}>
          audit · time-travel slider + raw event stream
        </summary>
        <div className="card" style={{ marginTop: '.5rem', padding: '.7rem .9rem' }}>
          {!timeline ? (
            <div className="subtle" style={{ fontSize: '.75rem' }}>loading raw audit stream…</div>
          ) : (
            <>
              <div className="subtle" style={{ fontSize: '.72rem', marginBottom: '.55rem' }}>
                Raw chronological stream of every signal, fact, post and gate. Drag the slider to reconstruct state at any past point.
              </div>
              {minTs && maxTs && (
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
              )}
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
              <div style={{ marginTop: '.75rem' }}>
                <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>raw stream · {timeline.items.length} entries</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '.3rem', maxHeight: 400, overflowY: 'auto' }}>
                  {timeline.items.slice(0, 100).map((it) => (
                    <div key={`${it.kind}-${it.id}`} className="mono subtle" style={{ fontSize: '.72rem' }}>
                      [{it.ts.slice(0, 16)}] {it.kind} · {it.summary}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </details>
    </section>
  );
}

function ActivityRow({
  item, ws, entity_id, expanded, onToggle,
}: {
  item: GroupedItem;
  ws: string;
  entity_id: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = KIND_LABEL[item.kind] ?? { label: item.kind, cls: 'badge-mute' };
  const isDraft = item.kind === 'touch_draft';
  const truncated = item.body.length > 220;
  const display = expanded || !truncated ? item.body : item.body.slice(0, 220) + '…';
  const isClickable = truncated || isDraft || !!item.reasoning;

  return (
    <div
      className="card"
      style={{ padding: '.7rem .9rem', cursor: isClickable ? 'pointer' : 'default' }}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('a, button')) return;
        if (isClickable) onToggle();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.3rem' }}>
        <span className={`badge ${meta.cls}`}>{meta.label}</span>
        {item.dup_count > 1 && (
          <span className="mono muted" style={{ fontSize: '.7rem', padding: '1px 6px', background: 'var(--panel-2)', borderRadius: 4 }} title={`${item.dup_count} identical entries`}>
            ×{item.dup_count}
          </span>
        )}
        <span className="muted mono" style={{ fontSize: '.7rem', marginLeft: 'auto' }}>
          <Timestamp value={item.ts} />
        </span>
      </div>
      <div style={{ fontSize: '.85rem', whiteSpace: 'pre-wrap', lineHeight: 1.55, fontFamily: isDraft ? 'var(--font-mono)' : 'var(--font-sans)', color: 'var(--text)' }}>
        {display}
      </div>
      {expanded && item.reasoning && (
        <div
          style={{
            marginTop: '.5rem', padding: '.5rem .7rem',
            background: 'var(--panel-2)', borderLeft: '3px solid var(--accent-blue)', borderRadius: 4,
            fontSize: '.78rem', color: 'var(--text-2)', whiteSpace: 'pre-wrap', lineHeight: 1.5,
          }}
        >
          <div className="subtle" style={{ fontSize: '.66rem', marginBottom: '.2rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>why</div>
          {item.reasoning}
        </div>
      )}
      {isDraft && <DraftActions postId={item.id} workspaceId={ws} />}
      {(truncated || item.reasoning || item.cites.length > 0) && (
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.5rem', flexWrap: 'wrap' }}>
          {(truncated || item.reasoning) && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              style={{ fontSize: '.72rem', background: 'transparent', color: 'var(--accent-blue)', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              {expanded ? 'collapse' : item.reasoning ? 'why?' : 'expand'}
            </button>
          )}
          {expanded && (
            <WhyThis workspace_id={ws} entity_id={entity_id} ts={item.ts} cites={item.cites} />
          )}
          {item.cites.length > 0 && expanded && (
            <>
              <span className="subtle" style={{ fontSize: '.7rem' }}>cites:</span>
              {item.cites.map((c) => <CiteChain key={c} fact_id={c} />)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
