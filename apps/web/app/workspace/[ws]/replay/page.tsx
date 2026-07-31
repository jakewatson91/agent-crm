'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useSWR, DEFAULT_SWR } from '../../../_lib/swr';
import { Timestamp } from '../../../_components/Timestamp';
import { CiteChain } from '../../../_components/CiteChain';
import { WhyThis } from '../../../_components/WhyThis';
import { CitedText } from '../../../_components/CitedText';

interface Summary {
  ts: string;
  counts: {
    entities: number;
    active_facts: number;
    total_facts: number;
    signals: number;
    posts: number;
    gates_total: number;
    gates_open: number;
  };
  top_signals: Array<{
    id: string;
    type: string;
    magnitude: number;
    entity_id: string;
    entity_name: string;
    source: string | null;
    url: string | null;
    observed_at: string;
    body: string;
  }>;
  top_posts: Array<{
    id: string;
    kind: string;
    created_at: string;
    body: string;
    cites: string[];
    cite_quotes: { fact_id: string; quote: string }[];
    reasoning: string | null;
    entity_id: string | null;
    entity_name: string;
  }>;
  newest_entities: Array<{
    id: string;
    name: string;
    kind: string;
    domain: string | null;
    created_at: string;
    scores: Record<string, { value: number; fact_id: string }>;
  }>;
}

const SCORE_LABELS: Record<string, string> = {
  score_industry_match: 'industry',
  score_stage_match: 'stage',
  score_signal_strength: 'signal',
  score_evidence_depth: 'evidence',
  score_recency: 'recency',
  score_graph_proximity: 'graph',
  score_total: 'total',
};
const SCORE_ORDER = [
  'score_total',
  'score_industry_match',
  'score_stage_match',
  'score_signal_strength',
  'score_evidence_depth',
  'score_recency',
  'score_graph_proximity',
];

function scoreColor(v: number): string {
  if (v >= 0.7) return 'var(--accent-green)';
  if (v >= 0.5) return 'var(--accent-amber)';
  if (v >= 0.3) return 'var(--accent-amber)';
  return 'var(--accent-coral)';
}

const POST_KIND_BADGE: Record<string, string> = {
  claim: 'badge-blue',
  decision: 'badge-purple',
  touch_draft: 'badge-green',
  gate_request: 'badge-coral',
  outcome: 'badge-amber',
  system: 'badge-mute',
  question: 'badge-amber',
};

export default function ReplayPage() {
  const params = useParams<{ ws: string }>();
  const [ts, setTs] = useState<string>('');
  useEffect(() => { setTs(new Date().toISOString()); }, []);
  const summaryRes = useSWR<Summary & { error?: string }>(
    ts ? `/api/replay/summary?workspace_id=${params.ws}&ts=${encodeURIComponent(ts)}` : null,
    DEFAULT_SWR,
  );
  const summary = summaryRes.data && !summaryRes.data.error ? summaryRes.data : null;
  const error = summaryRes.data?.error ?? (summaryRes.error instanceof Error ? summaryRes.error.message : null);
  const loading = ts !== '' && !summaryRes.data && !summaryRes.error;
  const load = (atTs: string) => setTs(atTs);

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Replay</h2>
      <p className="subtle" style={{ fontSize: '.9rem' }}>
        Reconstruct system state at any point in the past. Drag time backward to see what the agent saw before each decision.
      </p>

      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        <input
          type="datetime-local"
          value={ts ? ts.slice(0, 16) : ''}
          onChange={(e) => setTs(new Date(e.target.value).toISOString())}
          style={{
            background: 'var(--panel)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            padding: '.5rem .65rem',
            borderRadius: 6,
            fontFamily: 'inherit',
            fontSize: '.85rem',
          }}
        />
        <button
          onClick={() => load(ts)}
          disabled={loading || !ts}
          style={{
            padding: '.5rem 1rem',
            background: 'var(--accent-blue)',
            color: 'white',
            border: 'none',
            opacity: loading || !ts ? 0.5 : 1,
          }}
        >
          {loading ? 'replaying…' : 'replay to ts'}
        </button>
        <button
          onClick={() => { const now = new Date().toISOString(); setTs(now); load(now); }}
          disabled={loading}
          style={{
            padding: '.5rem 1rem',
            background: 'var(--panel-2)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
            fontSize: '.85rem',
          }}
        >
          now
        </button>
      </div>

      {error && (
        <div className="card" style={{ borderLeft: '3px solid var(--accent-coral)', color: 'var(--accent-coral)', fontSize: '.88rem' }}>
          ✗ {error}
        </div>
      )}

      {!error && summary && (
        <>
          <CountsRow counts={summary.counts} />
          <Block title="Top 5 signals (most recent before cutoff)">
            {summary.top_signals.length === 0 ? (
              <Empty>No signals yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.55rem' }}>
                {summary.top_signals.map((sig) => (
                  <div key={sig.id} className="card" style={{ padding: '.7rem .85rem' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '.55rem', flexWrap: 'wrap', marginBottom: '.3rem' }}>
                      <span className="badge badge-blue">{sig.type}</span>
                      {sig.source && <span className="badge badge-mute mono">{sig.source}</span>}
                      <Link href={`/workspace/${params.ws}/entities/${sig.entity_id}`} style={{ fontWeight: 600, color: 'var(--text)' }}>
                        {sig.entity_name}
                      </Link>
                      <span className="muted mono" style={{ fontSize: '.7rem' }}>mag {sig.magnitude.toFixed(2)}</span>
                      <span className="muted mono" style={{ fontSize: '.7rem', marginLeft: 'auto' }}>
                        <Timestamp value={sig.observed_at} />
                      </span>
                    </div>
                    {sig.body ? (
                      <div style={{ fontSize: '.85rem', lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>
                        {sig.body.length > 320 ? sig.body.slice(0, 320) + '…' : sig.body}
                      </div>
                    ) : (
                      <div className="muted" style={{ fontStyle: 'italic', fontSize: '.78rem' }}>(no body text)</div>
                    )}
                    {sig.url && (
                      <a href={sig.url} target="_blank" rel="noopener noreferrer" className="mono" style={{ fontSize: '.72rem', color: 'var(--accent-blue)', marginTop: '.3rem', display: 'inline-block' }}>
                        ↗ {sig.url.replace(/^https?:\/\//, '')}
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Block>

          <Block title="Recent agent actions">
            {summary.top_posts.length === 0 ? (
              <Empty>No posts yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.45rem' }}>
                {summary.top_posts.map((p) => (
                  <div key={p.id} className="card" style={{ padding: '.6rem .85rem' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '.5rem', flexWrap: 'wrap', marginBottom: '.2rem' }}>
                      <span className={`badge ${POST_KIND_BADGE[p.kind] ?? 'badge-mute'}`}>{p.kind.replace('_', ' ')}</span>
                      <strong style={{ fontSize: '.88rem' }}>{p.entity_name}</strong>
                      <span className="muted mono" style={{ fontSize: '.7rem', marginLeft: 'auto' }}>
                        <Timestamp value={p.created_at} />
                      </span>
                    </div>
                    <div style={{
                      fontSize: '.82rem',
                      color: 'var(--text-2)',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.5,
                      fontFamily: p.kind === 'touch_draft' ? 'var(--font-mono)' : 'var(--font-sans)',
                    }}>
                      {(() => {
                        const shown = p.body.length > 280 ? p.body.slice(0, 280) + '…' : p.body;
                        return p.kind === 'touch_draft' && p.cites.length > 0 ? <CitedText text={shown} cites={p.cites} citeQuotes={p.cite_quotes} /> : shown;
                      })()}
                    </div>
                    {p.cites.length > 0 && p.entity_id && (
                      <div style={{ marginTop: '.35rem' }}>
                        <WhyThis
                          postId={p.id}
                          workspace_id={params.ws}
                          entity_id={p.entity_id}
                          ts={p.created_at}
                          reasoning={p.reasoning}
                          cites={p.cites}
                        />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Block>

          <Block title="Newest entities at this point">
            {summary.newest_entities.length === 0 ? (
              <Empty>No entities yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '.45rem' }}>
                {summary.newest_entities.map((e) => {
                  const scoreEntries = SCORE_ORDER
                    .map((k) => ({ key: k, label: SCORE_LABELS[k] ?? k, value: e.scores[k]?.value, fact_id: e.scores[k]?.fact_id }))
                    .filter((s): s is { key: string; label: string; value: number; fact_id: string } => typeof s.value === 'number');
                  return (
                    <div key={e.id} className="card" style={{ padding: '.6rem .85rem' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem', flexWrap: 'wrap' }}>
                        <span className="badge badge-mute">{e.kind}</span>
                        <strong style={{ fontSize: '.88rem' }}>{e.name}</strong>
                        {e.domain && <span className="muted mono" style={{ fontSize: '.72rem' }}>{e.domain}</span>}
                        <span className="muted mono" style={{ fontSize: '.7rem', marginLeft: 'auto' }}>
                          <Timestamp value={e.created_at} />
                        </span>
                      </div>
                      {scoreEntries.length > 0 && (
                        <div style={{ display: 'flex', gap: '.4rem', marginTop: '.5rem', flexWrap: 'wrap' }}>
                          {scoreEntries.map((s) => (
                            <div key={s.key} style={{ display: 'flex', flexDirection: 'column', gap: '.15rem', minWidth: 72 }}>
                              <div className="muted" style={{ fontSize: '.62rem', textTransform: 'uppercase', letterSpacing: '.05em' }}>{s.label}</div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '.3rem' }}>
                                <div style={{ height: 4, background: 'var(--panel-2)', borderRadius: 2, width: 48, overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${Math.round(s.value * 100)}%`, background: scoreColor(s.value) }} />
                                </div>
                                <span className="mono" style={{ fontSize: '.7rem', color: 'var(--text-2)' }}>{s.value.toFixed(2)}</span>
                              </div>
                              <CiteChain fact_id={s.fact_id} label="trace" />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Block>
        </>
      )}
    </section>
  );
}

function CountsRow({ counts }: { counts: Summary['counts'] }) {
  const items: Array<{ label: string; value: number; hint?: string }> = [
    { label: 'entities',     value: counts.entities },
    { label: 'active facts', value: counts.active_facts, hint: `${counts.total_facts} total` },
    { label: 'signals',      value: counts.signals },
    { label: 'posts',        value: counts.posts },
    { label: 'open gates',   value: counts.gates_open, hint: `${counts.gates_total} total` },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '.6rem', marginBottom: '1.5rem' }}>
      {items.map((i) => (
        <div key={i.label} className="card" style={{ padding: '.7rem .9rem' }}>
          <div className="subtle" style={{ fontSize: '.7rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>{i.label}</div>
          <div style={{ fontSize: '1.4rem', fontWeight: 600, marginTop: '.15rem' }}>{i.value.toLocaleString()}</div>
          {i.hint && <div className="muted" style={{ fontSize: '.72rem' }}>{i.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: '1.75rem' }}>
      <h3 style={{ fontSize: '.95rem', margin: '0 0 .55rem' }}>{title}</h3>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="card" style={{ textAlign: 'center', color: 'var(--text-3)', padding: '1.5rem', borderStyle: 'dashed' }}>
      {children}
    </div>
  );
}
