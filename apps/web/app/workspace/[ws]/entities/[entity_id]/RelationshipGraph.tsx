'use client';

/**
 * The account's neighborhood as a one-hop node graph: this entity in the
 * center, its people and related companies around it, each edge labeled with
 * the relationship. Click any node to walk to that entity's own page (which
 * shows its graph) — the "walk the graph" move, without an in-place re-center
 * that would desync from the rest of the page.
 *
 * Nodes are real links with text labels, so this stays keyboard- and
 * screen-reader-navigable; the SVG only draws the connecting lines.
 */
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

export interface GraphNeighbor {
  entity_id: string;
  name: string;
  kind: string;
  rel: string; // human relationship label ("works at", "invested in", …)
  confidence: number;
}

const HEIGHT = 340;
const MAX_NODES = 10;

// Kind → accent. Shape-based (company / contact / product / other), no
// vertical values. Everything the agent invents falls to the "other" color.
function kindColor(kind: string): string {
  if (kind === 'account' || kind === 'company') return 'var(--accent-blue)';
  if (kind === 'contact' || kind === 'person') return 'var(--accent-green)';
  if (kind === 'product') return 'var(--accent-amber)';
  return 'var(--accent-purple)';
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function RelationshipGraph({
  ws,
  centerName,
  centerKind,
  neighbors,
}: {
  ws: string;
  centerName: string;
  centerKind: string;
  neighbors: GraphNeighbor[];
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(280, e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = neighbors.slice(0, MAX_NODES);
  const extra = neighbors.length - shown.length;
  const cx = w / 2;
  const cy = HEIGHT / 2;
  const Rx = Math.max(130, w * 0.37);
  const Ry = HEIGHT * 0.37;

  const positions = shown.map((_, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, shown.length);
    // Alternate the radius slightly so adjacent labels don't collide.
    const k = i % 2 === 0 ? 1 : 0.8;
    return { x: cx + Rx * k * Math.cos(ang), y: cy + Ry * k * Math.sin(ang) };
  });

  return (
    <div
      ref={wrapRef}
      role="group"
      aria-label={`Relationships for ${centerName}`}
      style={{ position: 'relative', width: '100%', height: HEIGHT, overflow: 'hidden' }}
    >
      <svg width={w} height={HEIGHT} style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
        {positions.map((p, i) => (
          <line
            key={i}
            x1={cx} y1={cy} x2={p.x} y2={p.y}
            stroke="var(--border-strong)" strokeWidth={1.5}
          />
        ))}
      </svg>

      {/* edge labels, positioned at the midpoint of each line */}
      {positions.map((p, i) => {
        const mx = cx + (p.x - cx) * 0.5;
        const my = cy + (p.y - cy) * 0.5;
        return (
          <span
            key={`lab${i}`}
            className="mono"
            style={{
              position: 'absolute', left: mx, top: my, transform: 'translate(-50%,-50%)',
              fontSize: '.62rem', color: 'var(--text-3)', background: 'var(--panel)',
              padding: '0 4px', borderRadius: 4, whiteSpace: 'nowrap', pointerEvents: 'none',
            }}
          >
            {shown[i]!.rel}
          </span>
        );
      })}

      {/* center node — the current entity, not a link */}
      <div
        style={{
          position: 'absolute', left: cx, top: cy, transform: 'translate(-50%,-50%)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          padding: '.5rem .85rem', borderRadius: 12, whiteSpace: 'nowrap', textAlign: 'center',
          background: 'var(--panel)', border: `1px solid ${kindColor(centerKind)}`,
          boxShadow: 'var(--shadow)',
        }}
      >
        <span style={{ position: 'absolute', top: -4, right: -4, width: 9, height: 9, borderRadius: '50%', background: kindColor(centerKind), border: '2px solid var(--panel)' }} />
        <span style={{ fontSize: '.9rem', fontWeight: 650, color: 'var(--text)' }}>{trunc(centerName, 22)}</span>
        <span className="mono" style={{ fontSize: '.6rem', color: 'var(--text-3)' }}>{centerKind}</span>
      </div>

      {/* neighbor nodes */}
      {shown.map((n, i) => {
        const p = positions[i]!;
        return (
          <Link
            key={n.entity_id + i}
            href={`/workspace/${ws}/entities/${n.entity_id}`}
            className="graph-node"
            title={`${n.name} · ${n.rel}`}
            style={{
              position: 'absolute', left: p.x, top: p.y, transform: 'translate(-50%,-50%)',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
              padding: '.4rem .7rem', borderRadius: 11, whiteSpace: 'nowrap', textAlign: 'center',
              background: 'var(--panel)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)',
              textDecoration: 'none', maxWidth: Math.min(180, w * 0.42),
            }}
          >
            <span style={{ position: 'absolute', top: -4, right: -4, width: 8, height: 8, borderRadius: '50%', background: kindColor(n.kind), border: '2px solid var(--panel)' }} />
            <span style={{ fontSize: '.8rem', fontWeight: 550, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{trunc(n.name, 18)}</span>
            <span className="mono" style={{ fontSize: '.58rem', color: 'var(--text-3)' }}>{n.kind}</span>
          </Link>
        );
      })}

      {extra > 0 && (
        <div className="mono" style={{ position: 'absolute', bottom: 4, right: 6, fontSize: '.66rem', color: 'var(--text-3)' }}>
          +{extra} more connection{extra === 1 ? '' : 's'}
        </div>
      )}

      <style>{`
        .graph-node { transition: border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease; }
        .graph-node:hover { border-color: var(--accent-blue); transform: translate(-50%,-50%) scale(1.04); z-index: 3; }
        @media (prefers-reduced-motion: reduce) { .graph-node { transition: none; } .graph-node:hover { transform: translate(-50%,-50%); } }
      `}</style>
    </div>
  );
}
