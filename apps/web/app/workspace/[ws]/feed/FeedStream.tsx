'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Timestamp } from '../../../_components/Timestamp';
import { WhyThis } from '../../../_components/WhyThis';
import { DraftActions } from '../../../_components/DraftActions';
import { CitedText } from '../../../_components/CitedText';
import { useSetPageContext, type PageContext } from '../../../_components/PageContext';
import { type Band, BAND_LABEL, bandOf } from '../../../_lib/bands';
import { humanizePredicate, stripActionTag } from '../../../_lib/labels';

interface FeedItem {
  id: string;
  channel_id: string;
  channel_title: string;
  entity_id: string;
  entity_name: string;
  kind: 'claim' | 'decision' | 'touch_draft' | 'gate_request' | 'system' | 'outcome' | 'question';
  body: string;
  cites: string[];
  author_kind: string;
  author_id: string;
  created_at: string;
  icp_fit: number | null;
  reasoning: string | null;
  dup_count: number;
  pending_approval: boolean;
  gate: { id: string; policy: string; condition: Record<string, unknown> | null; decision: 'approve' | 'reject' | 'modify' | null; decided_at: string | null } | null;
  score_delta: number | null;
}

const KIND_META: Record<FeedItem['kind'], { label: string; badge: string; verb: string }> = {
  claim:        { label: 'new info',        badge: 'badge-blue',   verb: 'extracted facts on' },
  decision:     { label: 'note',            badge: 'badge-purple', verb: 'noted on' },
  touch_draft:  { label: 'outreach',        badge: 'badge-green',  verb: 'drafted outreach to' },
  gate_request: { label: 'needs approval',  badge: 'badge-coral',  verb: 'gated' },
  outcome:      { label: 'outcome',         badge: 'badge-amber',  verb: 'recorded outcome on' },
  system:       { label: 'system',          badge: 'badge-mute',   verb: 'noted on' },
  question:     { label: 'question',        badge: 'badge-amber',  verb: 'asked about' },
};

const DEFAULT_PREVIEW = 220;

type FilterKey = 'default' | 'outreach' | 'new_info' | 'needs_approval' | 'outcomes' | 'audit';

const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: 'default',        label: 'Default' },
  { key: 'outreach',       label: 'Outreach' },
  { key: 'new_info',       label: 'New info' },
  { key: 'needs_approval', label: 'Needs approval' },
  { key: 'outcomes',       label: 'Outcomes' },
  { key: 'audit',          label: 'Audit' },
];

const SINCE_OPTIONS = [
  { key: 'all', label: 'all time',  hours: null },
  { key: '24h', label: 'last 24h',  hours: 24 },
  { key: '7d',  label: 'last 7d',   hours: 24 * 7 },
  { key: '14d', label: 'last 14d',  hours: 24 * 14 },
] as const;
type SinceKey = typeof SINCE_OPTIONS[number]['key'];

// Which raw kinds belong to each filter. Default = everything consequential
// (state-changing or human-relevant). Audit = everything, raw. Specific tabs
// narrow to one kind.
function matchesFilter(it: FeedItem, key: FilterKey): boolean {
  switch (key) {
    case 'outreach':       return it.kind === 'touch_draft';
    case 'new_info':       return it.kind === 'claim' && it.cites.length > 0;
    // The live approval queue: outreach drafts with an undecided gate. These
    // rows carry the accept/edit/reject buttons (DraftActions). The raw
    // gate_request posts are audit records, not an action surface.
    case 'needs_approval': return it.kind === 'touch_draft' && it.pending_approval;
    case 'outcomes':       return it.kind === 'outcome';
    case 'audit':          return true;
    case 'default':
    default:
      // gate_request is excluded here on purpose: it's a legacy post kind
      // (the code path that created it has been removed) that's permanently
      // badged "needs approval" with no resolution shown, regardless of how
      // the gate it pointed at was actually decided. touch_draft already
      // carries the live pending_approval flag — gate_request stays visible
      // under Audit only.
      if (it.kind === 'touch_draft' || it.kind === 'outcome') return true;
      if (it.kind === 'claim' && it.cites.length > 0) return true;
      if (it.kind === 'decision') {
        // Only state-changing action-selector decisions surface in the default view.
        const b = it.body ?? '';
        return b.startsWith('[deep_research]') || b.startsWith('[drop]');
      }
      return false;
  }
}

function icpColor(v: number | null): string {
  if (v === null) return 'var(--text-3)';
  if (v >= 0.7) return 'var(--accent-green)';
  if (v >= 0.5) return 'var(--accent-amber)';
  if (v >= 0.3) return 'var(--accent-amber)';
  return 'var(--accent-coral)';
}

export function FeedStream({ items, ws }: { items: FeedItem[]; ws: string }) {
  const [filter, setFilter] = useState<FilterKey>('default');
  const [query, setQuery] = useState('');
  const [band, setBand] = useState<Band>('all');
  const [since, setSince] = useState<SinceKey>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Audit filters (search / score band / time window) narrow the stream
  // independently of the kind chips. `narrowed` is the set after these are
  // applied; the kind-chip counts and the final list both derive from it, so
  // the counts reflect what the chips would actually show.
  const narrowed = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hours = SINCE_OPTIONS.find((o) => o.key === since)?.hours ?? null;
    const sinceMs = hours ? Date.now() - hours * 3600_000 : null;
    return items.filter((it) => {
      if (q && !`${it.body} ${it.entity_name}`.toLowerCase().includes(q)) return false;
      if (band !== 'all' && bandOf(it.icp_fit) !== band) return false;
      if (sinceMs && Date.parse(it.created_at) < sinceMs) return false;
      return true;
    });
  }, [items, query, band, since]);

  const filtered = useMemo(() => narrowed.filter((i) => matchesFilter(i, filter)), [narrowed, filter]);

  // Reflect the active view into page context so ⌘J chat acts on the same set.
  const pageCtx = useMemo<PageContext>(() => {
    const active = [
      filter !== 'default' && `view=${filter}`,
      query.trim() && `search="${query.trim()}"`,
      band !== 'all' && `band=${band}`,
      since !== 'all' && `since=${since}`,
    ].filter(Boolean).join(', ');
    return {
      tab: 'feed',
      summary: active
        ? `${filtered.length} feed posts matching filters (${active})`
        : `${filtered.length} recent feed posts, newest first`,
      visible: filtered.slice(0, 10).map((it) => ({
        kind: 'entity',
        id: it.entity_id,
        label: `${it.entity_name} (${it.kind})`,
      })),
    };
  }, [filtered, filter, query, band, since]);
  useSetPageContext(pageCtx);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selStyle: React.CSSProperties = {
    fontSize: '.78rem', padding: '.3rem .5rem', borderRadius: 6,
    border: '1px solid var(--border)', background: 'var(--panel)', color: 'var(--text)',
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: '.4rem', marginBottom: '.6rem', flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count = narrowed.filter((i) => matchesFilter(i, f.key)).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: '.3rem .7rem',
                background: active ? 'var(--accent-blue-soft)' : 'var(--panel)',
                color: active ? '#4f6da3' : 'var(--text-2)',
                border: `1px solid ${active ? 'var(--accent-blue)' : 'var(--border)'}`,
                fontSize: '.78rem',
                fontWeight: 500,
              }}
            >
              {f.label} <span style={{ opacity: 0.6 }}>{count}</span>
            </button>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: '.5rem', marginBottom: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this view…"
          style={{ ...selStyle, flex: '1 1 180px', minWidth: 140 }}
        />
        <select value={band} onChange={(e) => setBand(e.target.value as Band)} style={selStyle} title="Filter by the agent's decision band">
          {(Object.keys(BAND_LABEL) as Band[]).map((b) => <option key={b} value={b}>{BAND_LABEL[b]}</option>)}
        </select>
        <select value={since} onChange={(e) => setSince(e.target.value as SinceKey)} style={selStyle} title="Time window">
          {SINCE_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      </div>

      {filtered.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', color: 'var(--text-3)', padding: '2rem' }}>
          No items match.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          {filtered.map((it) => (
            <FeedRow
              key={it.id}
              item={it}
              ws={ws}
              expanded={expanded.has(it.id)}
              onToggle={() => toggle(it.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeedRow({
  item,
  ws,
  expanded,
  onToggle,
}: {
  item: FeedItem;
  ws: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const meta = KIND_META[item.kind];
  // Strip the leading machine action tag (e.g. "[deep_research] …") and show it
  // as a small humanized chip instead of leaving the raw code in the sentence.
  const { tag, rest } = stripActionTag(item.body);
  const truncated = rest.length > DEFAULT_PREVIEW;
  const display = expanded || !truncated ? rest : rest.slice(0, DEFAULT_PREVIEW) + '…';
  const isDraft = item.kind === 'touch_draft';
  const isClickable = truncated;

  return (
    <div
      className="card"
      style={{ padding: '.85rem 1rem', cursor: isClickable ? 'pointer' : 'default' }}
      onClick={(e) => {
        // Don't toggle when clicking links or interactive children.
        const target = e.target as HTMLElement;
        if (target.closest('a, button')) return;
        if (isClickable) onToggle();
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.55rem', flexWrap: 'wrap', marginBottom: '.35rem' }}>
        <span className={`badge ${meta.badge}`}>{meta.label}</span>
        {tag && (
          <span className="badge badge-mute" style={{ fontSize: '.62rem' }} title={tag}>{humanizePredicate(tag)}</span>
        )}
        <Link
          href={`/workspace/${ws}/entities/${item.entity_id}`}
          style={{ fontWeight: 600, color: 'var(--text)', fontSize: '.95rem' }}
        >
          {item.entity_name}
        </Link>
        {item.icp_fit !== null && (
          <span
            className="mono"
            style={{
              fontSize: '.72rem',
              color: icpColor(item.icp_fit),
              padding: '1px 6px',
              background: 'var(--panel-2)',
              borderRadius: 4,
            }}
            title="composite score (signal, evidence, recency, fit, graph)"
          >
            score {item.icp_fit.toFixed(2)}
          </span>
        )}
        {item.score_delta !== null && Math.abs(item.score_delta) >= 0.005 && (
          <span
            className="mono"
            style={{
              fontSize: '.72rem',
              color: item.score_delta > 0 ? 'var(--accent-green)' : 'var(--accent-coral)',
              padding: '1px 6px',
              background: 'var(--panel-2)',
              borderRadius: 4,
            }}
            title="how much this signal moved the score"
          >
            {item.score_delta > 0 ? '+' : ''}{item.score_delta.toFixed(2)}
          </span>
        )}
        {item.dup_count > 1 && (
          <span
            className="mono muted"
            style={{ fontSize: '.7rem', padding: '1px 6px', background: 'var(--panel-2)', borderRadius: 4 }}
            title={`${item.dup_count} identical entries in the last 14d`}
          >
            ×{item.dup_count}
          </span>
        )}
        <span className="muted mono" style={{ fontSize: '.7rem', marginLeft: 'auto' }}>
          <Timestamp value={item.created_at} />
        </span>
      </div>

      <div
        style={{
          fontSize: '.86rem',
          color: 'var(--text)',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.55,
          fontFamily: isDraft ? 'var(--font-mono)' : 'var(--font-sans)',
        }}
      >
        {isDraft && item.cites.length > 0
          ? <CitedText text={display} cites={item.cites} />
          : display}
      </div>

      {isDraft && <DraftActions postId={item.id} workspaceId={ws} initialGate={item.gate} />}

      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.55rem', flexWrap: 'wrap' }}>
        {truncated && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            style={{
              fontSize: '.72rem',
              background: 'transparent',
              color: 'var(--accent-blue)',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
            }}
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
        <WhyThis
          postId={item.id}
          workspace_id={ws}
          entity_id={item.entity_id}
          ts={item.created_at}
          reasoning={item.reasoning}
          cites={item.cites}
        />
      </div>
    </div>
  );
}
