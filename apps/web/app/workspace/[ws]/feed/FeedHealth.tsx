'use client';

/**
 * Compact system-health strip atop the feed. Moved here when the standalone
 * Approvals tab was removed — the signal (stale approvals, errored sources,
 * stale drafts) still needs a home. This is audit, not a dashboard:
 * read-only, collapses to a single "all clear" badge when healthy.
 */
import { useSWR, DEFAULT_SWR } from '../../../_lib/swr';

interface Health {
  errored_sources: number;
  stale_gates: number;
  stale_drafts: number;
  error?: string;
}

export function FeedHealth({ ws }: { ws: string }) {
  const { data } = useSWR<Health>(`/api/admin/health?workspace_id=${ws}`, DEFAULT_SWR);
  if (!data || data.error) return null;

  const badges = [
    {
      label: 'pending approvals stale', value: data.stale_gates,
      hint: (n: number) => `${n} outreach approval${n === 1 ? '' : 's'} ${n === 1 ? 'has' : 'have'} been waiting on you for over a week`,
    },
    {
      label: 'stale drafts', value: data.stale_drafts,
      hint: (n: number) => `${n} drafted email${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} 7+ days old with no agent follow-up since`,
    },
    {
      label: 'errored sources', value: data.errored_sources,
      hint: (n: number) => `${n} data source${n === 1 ? '' : 's'} failed ${n === 1 ? 'its' : 'their'} last run`,
    },
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
        <span key={b.label} title={b.hint(b.value)} className={`badge ${b.value > 5 ? 'badge-coral' : 'badge-amber'}`}>
          {b.label}: {b.value}
        </span>
      ))}
    </div>
  );
}
