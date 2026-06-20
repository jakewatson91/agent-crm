'use client';

/**
 * Compact system-health strip atop the feed. Moved here when the standalone
 * Approvals tab was removed — the signal (stale approvals, errored sources,
 * unmatched signals) still needs a home. This is audit, not a dashboard:
 * read-only, collapses to a single "all clear" badge when healthy.
 */
import { useSWR, DEFAULT_SWR } from '../../../_lib/swr';

interface Health {
  unmatched_signals: number;
  errored_sources: number;
  stale_gates: number;
  stale_drafts: number;
  error?: string;
}

export function FeedHealth({ ws }: { ws: string }) {
  const { data } = useSWR<Health>(`/api/admin/health?workspace_id=${ws}`, DEFAULT_SWR);
  if (!data || data.error) return null;

  const badges = [
    { label: 'pending approvals stale', value: data.stale_gates, hint: '>7d undecided' },
    { label: 'stale drafts', value: data.stale_drafts, hint: '>7d, no follow-up' },
    { label: 'errored sources', value: data.errored_sources, hint: 'last run failed' },
    { label: 'unmatched signals', value: data.unmatched_signals, hint: '>30m old, no match' },
  ];
  const allHealthy = badges.every((b) => b.value === 0);

  return (
    <div
      className="card"
      style={{
        display: 'flex', gap: '.5rem', flexWrap: 'wrap', alignItems: 'center',
        marginBottom: '1rem', padding: '.5rem .85rem', fontSize: '.76rem',
      }}
    >
      <span className="subtle">system</span>
      {allHealthy && <span className="badge badge-green">✓ all clear</span>}
      {!allHealthy && badges.filter((b) => b.value > 0).map((b) => (
        <span key={b.label} title={b.hint} className={`badge ${b.value > 5 ? 'badge-coral' : 'badge-amber'}`}>
          {b.label}: {b.value}
        </span>
      ))}
    </div>
  );
}
