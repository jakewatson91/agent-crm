'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { CiteChain } from '../../../../_components/CiteChain';
import { Timestamp } from '../../../../_components/Timestamp';
import { WhyThis } from '../../../../_components/WhyThis';
import { CitedText } from '../../../../_components/CitedText';
import { DraftActions } from '../../../../_components/DraftActions';
import { lowConfLabel } from '../../../../_lib/confidence';
import { bandOf, bandColor, BAND_HEADLINE, BAND_VERDICT } from '../../../../_lib/bands';
import { humanizePredicate, looksLikeCode, stripActionTag } from '../../../../_lib/labels';
import { SCORE_DIMENSIONS, scoreWord } from '../../../../_lib/score_labels';
import { ScoreTimeline } from './ScoreTimeline';
import { AttributeGrid } from './AttributeGrid';
import { RelationshipGraph } from './RelationshipGraph';
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
  object_entity: string | null;
  object_entity_name: string | null;
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

// Score-related facts get their own clean card, not a row in the facts list.
function isScoreFact(p: string): boolean {
  return p === 'icp_fit' || p === 'score_total' || p === 'icp_fit_breakdown' || p === 'contact_score' || p.startsWith('score_');
}

// Facts a human can't read: the type fact (shown as a badge), the score
// internals (shown in the score card), raw JSON / error blobs, and bare codes.
// Entity-reference facts always stay — they render as a link.
function isMachineFact(f: { predicate: string; object_text: string | null; object_entity: string | null }): boolean {
  if (f.object_entity) return false;
  if (f.predicate === 'is_a') return true;
  if (isScoreFact(f.predicate)) return true;
  const v = (f.object_text ?? '').trim();
  if (v.startsWith('{') || v.startsWith('[')) return true;
  if (/^error[:\s]/i.test(v)) return true;
  if (looksLikeCode(f.predicate, f.object_text)) return true;
  return false;
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
  const [relatedOpen, setRelatedOpen] = useState(true);

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

  // The graph is the headline of this page, so load it on mount (not gated
  // behind the collapse). Reset + refetch when navigating between entities.
  useEffect(() => {
    let cancelled = false;
    setRelated(null);
    setRelatedLoading(true);
    fetch(`/api/entities/${entityId}/related`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setRelated(j); })
      .catch(() => { if (!cancelled) setRelated({ inbound: [], outbound: [] }); })
      .finally(() => { if (!cancelled) setRelatedLoading(false); });
    return () => { cancelled = true; };
  }, [entityId]);

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

  // Human facts view: drop machine facts (type, score internals, raw blobs,
  // codes) and skip families that empty out. Everything stays in the bottom
  // audit stream + the API.
  const visibleFacts: Record<string, Fact[]> = {};
  for (const [fam, arr] of Object.entries(currentFacts)) {
    const keep = arr.filter((f) => !isMachineFact(f));
    if (keep.length) visibleFacts[fam] = keep;
  }

  // Score card: a plain verdict + the agent's own words, instead of the 8 raw
  // score_* rows + JSON blob it writes. The numeric dimensions move into an
  // audit expander, each explained in plain language.
  const allFacts = Object.values(currentFacts).flat();
  const scoreComponents = allFacts
    .filter((f) => f.predicate.startsWith('score_') && f.predicate !== 'score_total' && f.object_text != null)
    .map((f) => {
      const key = f.predicate.replace(/^score_/, '');
      const meta = SCORE_DIMENSIONS[key];
      return { key, id: f.id, label: meta?.label ?? humanizePredicate(key), help: meta?.help ?? null, value: parseFloat(f.object_text as string) };
    })
    .filter((c) => Number.isFinite(c.value));
  // The scorer's plain-language explanation, stored on the breakdown fact. This
  // is the part that actually tells a human *why* the score is what it is.
  const scoreReasoning = (() => {
    const f = allFacts.find((x) => x.predicate === 'icp_fit_breakdown');
    if (!f?.object_text) return null;
    try {
      const j = JSON.parse(f.object_text) as { reasoning?: unknown };
      return typeof j.reasoning === 'string' && j.reasoning.trim() ? j.reasoning.trim() : null;
    } catch { return null; }
  })();
  const families = Object.keys(visibleFacts).sort((a, b) => {
    const order = ['firmographics', 'scoring', 'engagement', 'other'];
    return order.indexOf(a) - order.indexOf(b);
  });

  const countsLine = data
    ? `${data.counts.facts_active} facts · ${data.counts.recent} recent · ${data.counts.history} historical`
    : `${Object.values(currentFacts).reduce((n, arr) => n + arr.length, 0)} facts`;

  const inbound = related?.inbound ?? [];
  const outbound = related?.outbound ?? [];
  const neighborCount = inbound.length + outbound.length;

  // Flatten inbound + outbound into one neighbor list for the graph, highest
  // confidence first, each carrying its human relationship label.
  const graphNeighbors = [...inbound, ...outbound]
    .map((n) => ({ entity_id: n.entity_id, name: n.name, kind: n.kind, rel: predicateLabel(n.via_predicate), confidence: n.confidence, via_fact_id: n.via_fact_id }))
    .sort((a, b) => b.confidence - a.confidence);

  // Identity strip: linked domain + score chip, derived from attributes/facts.
  const domain = typeof entityAttributes.domain === 'string' ? entityAttributes.domain : null;
  const scoreStr = (() => {
    for (const arr of Object.values(currentFacts)) {
      const f = arr.find((x) => x.predicate === 'icp_fit') ?? arr.find((x) => x.predicate === 'score_total');
      if (f?.object_text) return f.object_text;
    }
    return null;
  })();
  const score = scoreStr != null && Number.isFinite(parseFloat(scoreStr)) ? parseFloat(scoreStr) : null;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '.5rem', marginBottom: '.5rem' }}>
        <h2 style={{ marginTop: 0, marginBottom: 0 }}>
          {entityName} <span className="badge badge-mute" style={{ marginLeft: '.5rem', fontSize: '.65rem' }}>{entityKind}</span>
        </h2>
        <div className="subtle mono" style={{ fontSize: '.75rem' }}>{countsLine}</div>
      </div>

      {domain && (
        <div style={{ display: 'flex', gap: '.6rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '.25rem' }}>
          <a
            href={`https://${domain}`}
            target="_blank"
            rel="noopener noreferrer"
            className="mono"
            style={{ fontSize: '.78rem', color: 'var(--accent-blue)', textDecoration: 'none' }}
          >
            {domain}
          </a>
        </div>
      )}

      <AttributeGrid attributes={entityAttributes} />

      {score !== null && (
        <div className="card" style={{ marginTop: '1rem', padding: '.8rem .9rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem', flexWrap: 'wrap' }}>
            <div className="subtle" style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>fit</div>
            <div style={{ fontSize: '.95rem', fontWeight: 600, color: bandColor(score) }}>{BAND_HEADLINE[bandOf(score)]}</div>
            <div className="subtle mono" style={{ fontSize: '.78rem' }}>{Math.round(score * 100)}% match</div>
          </div>
          <div className="subtle" style={{ fontSize: '.8rem', marginTop: '.3rem', color: 'var(--text-2)' }}>
            {BAND_VERDICT[bandOf(score)]}
          </div>
          {scoreReasoning && (
            <div style={{ fontSize: '.82rem', marginTop: '.55rem', lineHeight: 1.5, color: 'var(--text)' }}>
              {scoreReasoning}
            </div>
          )}
          {scoreComponents.length > 0 && (
            <details style={{ marginTop: '.6rem' }}>
              <summary className="subtle" style={{ cursor: 'pointer', fontSize: '.72rem' }}>how this score was reached</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.55rem', marginTop: '.55rem' }}>
                {scoreComponents.map((c) => (
                  <div key={c.key}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '.5rem' }}>
                      <span style={{ fontSize: '.78rem', color: 'var(--text)', minWidth: 130 }}>{c.label}</span>
                      <div style={{ flex: 1, height: 6, background: 'var(--panel-2)', borderRadius: 3, overflow: 'hidden', minWidth: 50 }}>
                        <div style={{ width: `${Math.round(c.value * 100)}%`, height: '100%', background: bandColor(c.value) }} />
                      </div>
                      <span className="subtle mono" style={{ fontSize: '.72rem', minWidth: 50, textAlign: 'right' }}>{scoreWord(c.value)}</span>
                    </div>
                    {c.help && (
                      <div className="subtle" style={{ fontSize: '.7rem', color: 'var(--text-3)', marginTop: '.12rem' }}>{c.help}</div>
                    )}
                    <div style={{ marginTop: '.15rem' }}>
                      <CiteChain fact_id={c.id} label="trace" />
                    </div>
                  </div>
                ))}
              </div>
            </details>
          )}
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
          {relatedOpen ? '▾' : '▸'} connections
          {related && ` · ${neighborCount}`}
        </button>
        {relatedOpen && (
          <div style={{ marginTop: '.75rem' }}>
            {relatedLoading && (
              <div className="subtle" style={{ fontSize: '.75rem' }}>loading…</div>
            )}
            {related && neighborCount === 0 && (
              <div className="card" style={{ padding: '1rem', color: 'var(--text-3)', textAlign: 'center', fontSize: '.85rem' }}>
                No connections in the graph yet.
              </div>
            )}
            {related && neighborCount > 0 && (
              <div className="card" style={{ padding: '.5rem' }}>
                <RelationshipGraph ws={ws} centerName={entityName} centerKind={entityKind} neighbors={graphNeighbors} />
              </div>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: '.4rem' }}>
                  {(visibleFacts[fam] ?? []).map((f) => (
                    <div key={f.id} style={{ fontSize: '.78rem' }}>
                      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline' }}>
                        <span className="subtle" style={{ color: 'var(--text-2)', minWidth: 160 }} title={f.predicate}>{humanizePredicate(f.predicate)}</span>
                        <span style={{ color: 'var(--text)', flex: 1, minWidth: 0 }}>
                          {f.object_entity && f.object_entity_name ? (
                            <Link href={`/workspace/${ws}/entities/${f.object_entity}`} style={{ color: 'var(--accent-blue)', textDecoration: 'none' }}>
                              {f.object_entity_name}
                            </Link>
                          ) : (
                            f.object_text ?? '—'
                          )}
                        </span>
                        <span className="muted mono" style={{ fontSize: '.68rem', whiteSpace: 'nowrap' }}>
                          {lowConfLabel(f.confidence) && (
                            <span style={{ color: 'var(--accent-coral)' }}>{lowConfLabel(f.confidence)} · </span>
                          )}
                          <Timestamp value={f.observed_at} />
                        </span>
                      </div>
                      <div style={{ marginLeft: 160, marginTop: '.1rem' }}>
                        <CiteChain fact_id={f.id} label="trace" />
                      </div>
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
                          <div key={f.id} style={{ display: 'flex', gap: '.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                            <span className="mono" style={{ fontSize: '.72rem', color: 'var(--badge-green-fg)' }}>
                              {f.predicate} = {f.object_text}
                            </span>
                            <CiteChain fact_id={f.id} label="trace" />
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
                      <div key={`${it.kind}-${it.id}`} className="mono subtle" style={{ fontSize: '.72rem', display: 'flex', gap: '.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                        <span>[{it.ts.slice(0, 16)}] {it.kind} · {it.summary}</span>
                        {it.kind === 'fact' && <CiteChain fact_id={it.id} label="trace" />}
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
  // Strip the leading machine action tag (e.g. "[deep_research] …") out of the
  // body and show it as a small humanized chip instead of raw text.
  const { tag, rest } = stripActionTag(item.body);
  const truncated = rest.length > 220;
  const display = expanded || !truncated ? rest : rest.slice(0, 220) + '…';
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
        {tag && (
          <span className="badge badge-mute" style={{ fontSize: '.62rem' }} title={tag}>{humanizePredicate(tag)}</span>
        )}
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
        {isDraft && item.cites.length > 0 ? <CitedText text={display} cites={item.cites} /> : display}
      </div>
      {isDraft && <DraftActions postId={item.id} workspaceId={ws} />}
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.5rem', flexWrap: 'wrap' }}>
        {truncated && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            style={{ fontSize: '.72rem', background: 'transparent', color: 'var(--accent-blue)', border: 'none', padding: 0, cursor: 'pointer' }}
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
        <WhyThis
          postId={item.id}
          workspace_id={ws}
          entity_id={entity_id}
          ts={item.ts}
          reasoning={item.reasoning}
          cites={item.cites}
        />
      </div>
    </div>
  );
}
