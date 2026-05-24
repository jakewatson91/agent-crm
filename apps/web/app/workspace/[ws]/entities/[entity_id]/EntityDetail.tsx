'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { CiteChain } from '../../../../_components/CiteChain';
import { Timestamp } from '../../../../_components/Timestamp';
import { WhyThis } from '../../../../_components/WhyThis';
import { DraftActions } from '../../../../_components/DraftActions';
import { lowConfLabel } from '../../../../_lib/confidence';
import { ScoreTimeline } from './ScoreTimeline';
import { useSetPageContext, type PageContext } from '../../../../_components/PageContext';

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

interface RelatedEntity {
  entity_id: string;
  name: string;
  kind: string;
  attributes: Record<string, unknown>;
  via_predicate: string;
  via_fact_id: string;
  confidence: number;
}

interface RelatedResponse {
  inbound: RelatedEntity[];
  outbound: RelatedEntity[];
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

// Renders a fact predicate as a human role label. Pattern-shaped; no
// vertical-specific values baked in.
function predicateLabel(predicate: string): string {
  if (predicate === 'works_at') return 'works at';
  if (predicate === 'advises') return 'advises';
  const m = predicate.match(/^is_(.+)_of$/);
  if (m && m[1]) return m[1].replace(/_/g, ' ');
  return predicate.replace(/_/g, ' ');
}

export function EntityDetail({
  ws,
  entityId,
  entityName,
  entityKind,
  entityAttributes,
  channelId,
}: {
  ws: string;
  entityId: string;
  entityName: string;
  entityKind: string;
  entityAttributes: Record<string, unknown>;
  channelId: string | null;
}) {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(!!channelId);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showHistory, setShowHistory] = useState(false);

  const [related, setRelated] = useState<RelatedResponse | null>(null);
  const [relatedLoading, setRelatedLoading] = useState(false);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [showAllInbound, setShowAllInbound] = useState(false);
  const [showAllOutbound, setShowAllOutbound] = useState(false);

  // Audit slider state — channel-scoped today. Hidden when no channel.
  const [timeline, setTimeline] = useState<TimelineResponse | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [replayTs, setReplayTs] = useState<string | null>(null);
  const [replayState, setReplayState] = useState<ReplayResponse | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  // Facts come from /summary on account pages; fall back to a thin facts fetch
  // for other kinds (no channel exists).
  const [thinFacts, setThinFacts] = useState<Record<string, Fact[]> | null>(null);

  const pageCtx = useMemo<PageContext>(() => ({
    tab: 'entity_detail',
    summary: `viewing entity ${entityName} (${entityKind})`,
    visible: [{ kind: entityKind, id: entityId, label: entityName }],
    data: channelId ? { channel_id: channelId } : undefined,
  }), [entityId, entityName, entityKind, channelId]);
  useSetPageContext(pageCtx);

  useEffect(() => {
    if (!channelId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(`/api/channels/${channelId}/summary`)
      .then((r) => r.json())
      .then((j) => setData(j))
      .finally(() => setLoading(false));
  }, [channelId]);

  useEffect(() => {
    if (!relatedOpen || related || relatedLoading) return;
    setRelatedLoading(true);
    fetch(`/api/entities/${entityId}/related`)
      .then((r) => r.json())
      .then((j) => setRelated(j))
      .catch(() => setRelated({ inbound: [], outbound: [] }))
      .finally(() => setRelatedLoading(false));
  }, [entityId, relatedOpen, related, relatedLoading]);

  // Thin facts fetch for non-account kinds. Groups by the same families the
  // summary route uses so the UI stays consistent.
  useEffect(() => {
    if (channelId) return;
    fetch(`/api/entities/${entityId}/facts`)
      .then((r) => (r.ok ? r.json() : { grouped: {} }))
      .then((j) => setThinFacts(j.grouped ?? {}))
      .catch(() => setThinFacts({}));
  }, [entityId, channelId]);

  useEffect(() => {
    if (!auditOpen || timeline || !channelId) return;
    fetch(`/api/channels/${channelId}/timeline`).then((r) => r.json()).then((j) => setTimeline(j));
  }, [auditOpen, channelId, timeline]);

  useEffect(() => {
    if (!replayTs) { setReplayState(null); return; }
    setReplayLoading(true);
    fetch('/api/primitives/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace_id: ws, ts: replayTs }),
    }).then((r) => r.json())
      .then((j) => setReplayState(j))
      .finally(() => setReplayLoading(false));
  }, [replayTs, ws]);

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

  const currentFacts: Record<string, Fact[]> = data?.current_facts ?? thinFacts ?? {};
  const replayActiveFacts = replayState?.facts?.filter((f) => f.subject_entity === entityId) ?? [];
  const families = Object.keys(currentFacts).sort((a, b) => {
    const order = ['firmographics', 'scoring', 'engagement', 'other'];
    return order.indexOf(a) - order.indexOf(b);
  });

  const countsLine = data
    ? `${data.counts.facts_active} facts · ${data.counts.recent} recent · ${data.counts.history} historical`
    : `${Object.values(currentFacts).reduce((n, arr) => n + arr.length, 0)} facts`;

  const inbound = related?.inbound ?? [];
  const outbound = related?.outbound ?? [];

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '.5rem', marginBottom: '.5rem' }}>
        <h2 style={{ marginTop: 0, marginBottom: 0 }}>
          {entityName} <span className="badge badge-mute" style={{ marginLeft: '.5rem', fontSize: '.65rem' }}>{entityKind}</span>
        </h2>
        <div className="subtle mono" style={{ fontSize: '.75rem' }}>{countsLine}</div>
      </div>

      {Object.keys(entityAttributes).length > 0 && (
        <div className="card" style={{ marginTop: '1rem', padding: '.7rem .9rem' }}>
          <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.3rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>attributes</div>
          <pre className="mono subtle" style={{ margin: 0, fontSize: '.72rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {JSON.stringify(entityAttributes, null, 2)}
          </pre>
        </div>
      )}

      <div style={{ marginTop: '1.5rem' }}>
        <button
          onClick={() => setRelatedOpen((v) => !v)}
          className="subtle"
          style={{
            background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
            fontSize: '.78rem', textTransform: 'uppercase', letterSpacing: '.06em',
            color: 'var(--text-2)',
          }}
        >
          {relatedOpen ? '▾' : '▸'} related entities
          {related && ` · ${inbound.length + outbound.length}`}
        </button>
        {relatedOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem', marginTop: '.75rem' }}>
            {relatedLoading && (
              <div className="subtle" style={{ fontSize: '.75rem' }}>loading…</div>
            )}
            {related && inbound.length === 0 && outbound.length === 0 && (
              <div className="card" style={{ padding: '1rem', color: 'var(--text-3)', textAlign: 'center', fontSize: '.85rem' }}>
                No related entities yet.
              </div>
            )}
            {inbound.length > 0 && (
              <RelatedGroup
                ws={ws}
                title={entityKind === 'account' ? 'contacts' : 'inbound'}
                items={inbound}
                expanded={showAllInbound}
                onToggle={() => setShowAllInbound((v) => !v)}
              />
            )}
            {outbound.length > 0 && (
              <RelatedGroup
                ws={ws}
                title={entityKind === 'contact' ? 'works at' : 'linked to'}
                items={outbound}
                expanded={showAllOutbound}
                onToggle={() => setShowAllOutbound((v) => !v)}
              />
            )}
          </div>
        )}
      </div>

      {data && (
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
                  ws={ws}
                  entity_id={entityId}
                  expanded={expanded.has(`${it.kind}::${it.ts}`)}
                  onToggle={() => toggle(`${it.kind}::${it.ts}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      <ScoreTimeline entity_id={entityId} />

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
                  {(currentFacts[fam] ?? []).map((f) => (
                    <div key={f.id} className="mono" style={{ fontSize: '.78rem', display: 'flex', gap: '.5rem', alignItems: 'baseline' }}>
                      <span style={{ color: 'var(--text-2)', minWidth: 160 }}>{f.predicate}</span>
                      <span style={{ color: 'var(--text)' }}>{f.object_text}</span>
                      <span className="muted mono" style={{ fontSize: '.68rem', marginLeft: 'auto' }}>
                        {lowConfLabel(f.confidence) && (
                          <span style={{ color: 'var(--accent-coral)' }}>{lowConfLabel(f.confidence)} · </span>
                        )}
                        <Timestamp value={f.observed_at} />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {data && data.history.length > 0 && (
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
          {showHistory && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem', marginTop: '.75rem' }}>
              {data.history.map((it) => (
                <ActivityRow
                  key={`hist::${it.kind}::${it.ts}`}
                  item={it}
                  ws={ws}
                  entity_id={entityId}
                  expanded={expanded.has(`hist::${it.kind}::${it.ts}`)}
                  onToggle={() => toggle(`hist::${it.kind}::${it.ts}`)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {channelId && (
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
      )}
    </section>
  );
}

function RelatedGroup({
  ws,
  title,
  items,
  expanded,
  onToggle,
}: {
  ws: string;
  title: string;
  items: RelatedEntity[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const collapsedLimit = 5;
  const shown = expanded ? items : items.slice(0, collapsedLimit);
  const hasMore = items.length > collapsedLimit;

  return (
    <div className="card" style={{ padding: '.7rem .9rem' }}>
      <div className="subtle" style={{ fontSize: '.7rem', marginBottom: '.4rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {title} · {items.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem' }}>
        {shown.map((r) => (
          <div key={r.via_fact_id} style={{ display: 'flex', gap: '.6rem', alignItems: 'baseline', fontSize: '.82rem' }}>
            <Link href={`/workspace/${ws}/entities/${r.entity_id}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
              {r.name}
            </Link>
            <span className="badge badge-mute" style={{ fontSize: '.62rem' }}>{r.kind}</span>
            <span className="subtle mono" style={{ fontSize: '.7rem' }}>{predicateLabel(r.via_predicate)}</span>
            {lowConfLabel(r.confidence) && (
              <span className="mono" style={{ fontSize: '.68rem', marginLeft: 'auto', color: 'var(--accent-coral)' }}>
                {lowConfLabel(r.confidence)}
              </span>
            )}
          </div>
        ))}
      </div>
      {hasMore && (
        <button
          onClick={onToggle}
          style={{ marginTop: '.4rem', fontSize: '.72rem', background: 'transparent', color: 'var(--accent-blue)', border: 'none', padding: 0, cursor: 'pointer' }}
        >
          {expanded ? 'show fewer' : `show all ${items.length}`}
        </button>
      )}
    </div>
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
  const isClickable = truncated;

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
      {isDraft && <DraftActions postId={item.id} workspaceId={ws} />}
      {(truncated || item.reasoning || item.cites.length > 0) && (
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.5rem', flexWrap: 'wrap' }}>
          {truncated && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              style={{ fontSize: '.72rem', background: 'transparent', color: 'var(--accent-blue)', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              {expanded ? 'collapse' : 'expand'}
            </button>
          )}
          {(item.reasoning || item.cites.length > 0) && (
            <WhyThis
              postId={item.id}
              workspace_id={ws}
              entity_id={entity_id}
              ts={item.ts}
              reasoning={item.reasoning}
              cites={item.cites}
            />
          )}
        </div>
      )}
    </div>
  );
}
