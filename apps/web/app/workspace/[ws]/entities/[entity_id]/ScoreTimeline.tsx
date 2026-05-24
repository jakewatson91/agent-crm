'use client';

import { useEffect, useState } from 'react';
import { CiteChain } from '../../../../_components/CiteChain';
import { Timestamp } from '../../../../_components/Timestamp';
import { lowConfLabel } from '../../../../_lib/confidence';

function prettyUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    const combined = host + path;
    return combined.length > 50 ? combined.slice(0, 47) + '…' : combined;
  } catch {
    return url.length > 50 ? url.slice(0, 47) + '…' : url;
  }
}

interface CausedByFact {
  fact_id: string;
  predicate: string;
  object_text: string | null;
  confidence: number;
  observed_at: string;
  source_signal: { source_name: string | null; source_url: string | null } | null;
}

interface TimelineEntry {
  at: string;
  value: number | null;
  delta: number | null;
  caused_by: CausedByFact[];
}

interface ScoreHistoryResponse {
  entity_id: string;
  entries: TimelineEntry[];
  count: number;
}

/**
 * Score timeline — every score_total assertion for this entity, annotated
 * with the substantive facts asserted in the gap that caused the delta.
 * Collapsed by default. Mirrors the Related-Entities affordance pattern.
 */
export function ScoreTimeline({ entity_id }: { entity_id: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ScoreHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || data || loading) return;
    setLoading(true);
    fetch(`/api/entities/${entity_id}/score_history`)
      .then((r) => r.json())
      .then((j) => setData(j))
      .catch(() => setData({ entity_id, entries: [], count: 0 }))
      .finally(() => setLoading(false));
  }, [entity_id, open, data, loading]);

  // Render newest-first inside the panel.
  const entries = data?.entries ? [...data.entries].reverse() : [];

  return (
    <div style={{ marginTop: '1.75rem' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="subtle"
        style={{
          background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
          fontSize: '.78rem', textTransform: 'uppercase', letterSpacing: '.06em',
          color: 'var(--text-2)',
        }}
      >
        {open ? '▾' : '▸'} score timeline
        {data && ` · ${data.count}`}
      </button>

      {open && (
        <div style={{ marginTop: '.75rem' }}>
          {loading && <div className="subtle" style={{ fontSize: '.75rem' }}>loading…</div>}
          {data && entries.length === 0 && (
            <div className="card" style={{ padding: '1rem', color: 'var(--text-3)', textAlign: 'center', fontSize: '.85rem' }}>
              Never scored.
            </div>
          )}
          {entries.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '.6rem' }}>
              {entries.map((e, i) => (
                <TimelineRow key={`${e.at}-${i}`} entry={e} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }) {
  const { value, delta, at, caused_by } = entry;
  const valueStr = value != null ? value.toFixed(2) : '—';

  let arrow = '→';
  let arrowColor = 'var(--text-3)';
  let deltaLabel = 'initial';
  if (delta != null) {
    if (delta > 0.0049) { arrow = '↑'; arrowColor = '#5a7e5f'; deltaLabel = `+${delta.toFixed(2)}`; }
    else if (delta < -0.0049) { arrow = '↓'; arrowColor = 'var(--accent-coral)'; deltaLabel = delta.toFixed(2); }
    else { arrow = '→'; arrowColor = 'var(--text-3)'; deltaLabel = '±0.00'; }
  }

  return (
    <div className="card" style={{ padding: '.65rem .85rem' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem', flexWrap: 'wrap' }}>
        <span className="mono" style={{ color: arrowColor, fontWeight: 600, fontSize: '.95rem' }}>{arrow}</span>
        <span className="mono" style={{ color: 'var(--text)', fontSize: '.85rem', fontWeight: 600 }}>
          {valueStr}
        </span>
        <span className="mono" style={{ color: arrowColor, fontSize: '.75rem' }}>{deltaLabel}</span>
        <span className="muted mono" style={{ fontSize: '.7rem', marginLeft: 'auto' }}>
          <Timestamp value={at} />
        </span>
      </div>

      {caused_by.length === 0 ? (
        <div className="subtle" style={{ fontSize: '.72rem', marginTop: '.35rem', fontStyle: 'italic' }}>
          No new substantive facts in this window (rescore triggered by recompute or settings change).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.25rem', marginTop: '.4rem' }}>
          {caused_by.map((f) => (
            <div
              key={f.fact_id}
              className="mono"
              style={{ fontSize: '.74rem', display: 'flex', gap: '.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}
            >
              <span style={{ color: 'var(--text-3)' }}>↳</span>
              <span style={{ color: 'var(--text-2)' }}>
                {f.predicate} = {f.object_text ?? '—'}
              </span>
              {lowConfLabel(f.confidence) && (
                <span style={{ color: 'var(--accent-coral)', fontSize: '.66rem' }}>{lowConfLabel(f.confidence)}</span>
              )}
              {f.source_signal?.source_url && (
                <a
                  href={f.source_signal.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-blue)', fontSize: '.7rem', textDecoration: 'underline' }}
                  title={f.source_signal.source_url}
                >
                  ↗ {prettyUrl(f.source_signal.source_url)}
                </a>
              )}
              <CiteChain fact_id={f.fact_id} label="chain" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
