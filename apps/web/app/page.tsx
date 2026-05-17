import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerClient } from '@agent-crm/db';

export const dynamic = 'force-dynamic';

/**
 * Workspace router:
 *   0 workspaces  → wizard
 *   1 workspace   → that one's feed (preserves Jake's single-tenant flow)
 *   2+ workspaces → picker
 *
 * Single-tenant deployment: no auth UI yet. When multi-tenant lands, this
 * becomes a workspace picker scoped to the signed-in user.
 */
export default async function Home() {
  const sb = createServerClient();
  const ws = await sb.from('workspaces').select('id, name, created_at')
    .order('created_at', { ascending: false });
  const rows = (ws.data ?? []) as Array<{ id: string; name: string; created_at: string }>;

  if (rows.length === 0) {
    redirect('/workspace/new');
  }
  if (rows.length === 1 && rows[0]) {
    redirect(`/workspace/${rows[0].id}/channels`);
  }

  return (
    <main style={{ padding: '2rem', maxWidth: 720 }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>agent-crm</h1>
      <p style={{ color: 'var(--text-3)', marginBottom: '1.5rem' }}>Pick a workspace.</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rows.map((w) => (
          <li key={w.id} style={{ marginBottom: '.5rem' }}>
            <Link href={`/workspace/${w.id}/channels`} style={{ color: 'var(--text)', textDecoration: 'none', display: 'block', padding: '.75rem', border: '1px solid var(--border)', borderRadius: 6 }}>
              <div style={{ fontWeight: 500 }}>{w.name}</div>
              <div style={{ fontSize: '.75rem', color: 'var(--text-3)', fontFamily: 'monospace' }}>{w.id.slice(0, 8)}…</div>
            </Link>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: '1.5rem' }}>
        <Link href="/workspace/new" style={{ color: 'var(--text)', fontSize: '.9rem', textDecoration: 'underline' }}>+ new workspace</Link>
      </div>
    </main>
  );
}
