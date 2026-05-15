'use client';

import { useState, useMemo } from 'react';
import Link from 'next/link';
import { Timestamp } from '../../../_components/Timestamp';
import { CiteChain } from '../../../_components/CiteChain';
import { WhyThis } from '../../../_components/WhyThis';
import { DraftActions } from '../../../_components/DraftActions';

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

// Which raw kinds belong to each filter. Default = everything consequential
// (state-changing or human-relevant). Audit = everything, raw. Specific tabs
// narrow to one kind.
function matchesFilter(it: FeedItem, key: FilterKey): boolean {
  switch (key) {
    case 'outreach':       return it.kind === 'touch_draft';
    case 'new_info':       return it.kind === 'claim' && it.cites.length > 0;
    case 'needs_approval': return it.kind === 'gate_request';
    case 'outcomes':       return it.kind === 'outcome';
    case 'audit':          return true;
    case 'default':
    default:
      if (it.kind === 'touch_draft' || it.kind === 'gate_request' || it.kind === 'outcome') return true;
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => items.filter((i) => matchesFilter(i, filter)), [items, filter]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: '.4rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const count = items.filter((i) => matchesFilter(i, f.key)).length;
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
  const truncated = item.body.length > DEFAULT_PREVIEW;
  const display = expanded || !truncated ? item.body : item.body.slice(0, DEFAULT_PREVIEW) + '…';
  const isDraft = item.kind === 'touch_draft';
  const hasReasoning = !!item.reasoning;
  const isClickable = truncated || isDraft || hasReasoning || item.kind === 'decision';

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
        <Link
          href={`/workspace/${ws}/channels/${item.channel_id}`}
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
            title="latest icp_fit"
          >
            icp {item.icp_fit.toFixed(2)}
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
        {display}
      </div>

      {expanded && item.reasoning && (
        <div
          style={{
            marginTop: '.55rem',
            padding: '.5rem .75rem',
            background: 'var(--panel-2)',
            borderLeft: '3px solid var(--accent-purple, var(--accent-blue))',
            borderRadius: 4,
            fontSize: '.8rem',
            color: 'var(--text-2)',
            whiteSpace: 'pre-wrap',
            lineHeight: 1.5,
          }}
        >
          <div className="subtle" style={{ fontSize: '.68rem', marginBottom: '.25rem', textTransform: 'uppercase', letterSpacing: '.06em' }}>why</div>
          {item.reasoning}
        </div>
      )}

      {isDraft && <DraftActions postId={item.id} workspaceId={ws} />}

      {(truncated || isDraft || hasReasoning || item.cites.length > 0) && (
        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.55rem', flexWrap: 'wrap' }}>
          {(truncated || hasReasoning) && (
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
              {expanded ? 'collapse' : hasReasoning ? 'why?' : 'expand'}
            </button>
          )}
          {expanded && (
            <WhyThis
              workspace_id={ws}
              entity_id={item.entity_id}
              ts={item.created_at}
              cites={item.cites}
            />
          )}
          {item.cites.length > 0 && expanded && (
            <>
              <span className="muted" style={{ fontSize: '.7rem' }}>cites:</span>
              {item.cites.map((c) => (
                <CiteChain key={c} fact_id={c} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
