'use client';

/**
 * The two chart shapes the Today page uses. Both are inline SVG over data the
 * page already has: no chart library, no external service, nothing to load.
 *
 * DailyBars: one measure per day for 14 days. Three of these stack as small
 * multiples rather than one chart with three lines, because the measures have
 * different scales (hundreds of articles vs one or two drafts) and sharing an
 * axis would flatten the small one into a straight line.
 *
 * YieldMeter: a ratio against a total (how many of an angle's articles taught
 * us something). Fill and track are two steps of the same blue, per the meter
 * pattern, and every row carries its own value in text so the bar is never the
 * only way to read it.
 */
import { useState } from 'react';

const BAR_RADIUS = 4;
const BAR_GAP = 2;

/** A bar with rounded top corners and a square baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.max(0, Math.min(BAR_RADIUS, w / 2, h));
  if (h <= 0) return '';
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function shortDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function DailyBars({
  title,
  unit,
  points,
}: {
  title: string;
  unit: string;
  points: Array<{ day: string; value: number }>;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 300;
  const H = 54;
  const max = Math.max(1, ...points.map((p) => p.value));
  const slot = W / points.length;
  const w = Math.max(3, Math.min(24, slot - BAR_GAP));
  const total = points.reduce((n, p) => n + p.value, 0);
  const perDay = Math.round((total / points.length) * 10) / 10;
  const active = hover !== null ? points[hover] : null;

  // Deliberately no "today" figure here: these buckets are UTC calendar days
  // while the counters above cover a rolling 24 hours, so the two would print
  // different numbers for the same thing. The bars carry the shape; the header
  // carries the pace.
  return (
    <div style={{ position: 'relative', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '.4rem', marginBottom: '.35rem' }}>
        <span style={{ fontSize: '.78rem', color: 'var(--text-2)' }}>{title}</span>
        <span style={{ fontSize: '.95rem', fontWeight: 600, color: 'var(--text)' }}>{total.toLocaleString()}</span>
        <span className="muted" style={{ fontSize: '.7rem' }}>in 14 days · {perDay}/day</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}: ${points.map((p) => `${p.day} ${p.value}`).join(', ')}`}
        style={{ width: '100%', height: H, display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setHover(null)}
      >
        <line x1={0} y1={H} x2={W} y2={H} stroke="var(--border)" strokeWidth={1} />
        {points.map((p, i) => {
          const h = p.value === 0 ? 0 : Math.max(2, (p.value / max) * (H - 4));
          const x = i * slot + (slot - w) / 2;
          return (
            <g key={p.day} onMouseEnter={() => setHover(i)}>
              {/* Full-height hit target: the bars are too thin to hover reliably. */}
              <rect x={i * slot} y={0} width={slot} height={H} fill="transparent" />
              <path
                d={barPath(x, H - h, w, h)}
                fill={hover === i ? 'var(--chart-ink-strong)' : 'var(--chart-ink)'}
              />
              {p.value === 0 && <line x1={x} y1={H - 1} x2={x + w} y2={H - 1} stroke="var(--chart-track)" strokeWidth={2} />}
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '.3rem' }}>
        <span className="muted" style={{ fontSize: '.66rem' }}>{shortDay(points[0]?.day ?? '')}</span>
        <span className="muted" style={{ fontSize: '.66rem' }}>{shortDay(points[points.length - 1]?.day ?? '')}</span>
      </div>
      {active && (
        <div
          role="status"
          style={{
            position: 'absolute', top: -6, right: 0, zIndex: 2,
            background: 'var(--panel)', border: '1px solid var(--border-strong)',
            borderRadius: 6, padding: '.25rem .5rem', fontSize: '.7rem',
            color: 'var(--text)', boxShadow: 'var(--shadow)', whiteSpace: 'nowrap', pointerEvents: 'none',
          }}
        >
          {shortDay(active.day)}: <b>{active.value}</b> {unit}
        </div>
      )}
    </div>
  );
}

export function YieldMeter({
  label,
  value,
  total,
  caption,
}: {
  label: string;
  value: number;
  total: number;
  caption: string;
}) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 150px) 1fr auto', gap: '.7rem', alignItems: 'center', padding: '.3rem 0' }}>
      <span style={{ fontSize: '.82rem', color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={label}>
        {label}
      </span>
      <div
        style={{ height: 10, borderRadius: 5, background: 'var(--chart-track)', overflow: 'hidden' }}
        role="img"
        aria-label={`${label}: ${caption}`}
      >
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 5, background: 'var(--chart-ink)' }} />
      </div>
      <span className="mono" style={{ fontSize: '.72rem', color: 'var(--text-2)', whiteSpace: 'nowrap' }}>{caption}</span>
    </div>
  );
}
