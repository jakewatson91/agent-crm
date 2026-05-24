import Link from 'next/link';
import { redirect } from 'next/navigation';
import { requireUser } from './_lib/auth';
import { createUserServerClient } from './_lib/supabase-server';

export const dynamic = 'force-dynamic';

/**
 * Workspace router (post-auth):
 *   0 workspaces  → wizard
 *   1 workspace   → that one's feed
 *   2+ workspaces → picker
 *
 * Listing comes from the user-scoped client so RLS filters to workspaces the
 * signed-in user is a member of.
 */
export default async function Home() {
  await requireUser('/');
  const sb = await createUserServerClient();
  const ws = await sb.from('workspaces').select('id, name, created_at')
    .order('created_at', { ascending: false });
  const rows = (ws.data ?? []) as Array<{ id: string; name: string; created_at: string }>;

  if (rows.length === 0) {
    redirect('/workspace/new');
  }
  if (rows.length === 1 && rows[0]) {
    redirect(`/workspace/${rows[0].id}`);
  }

  return (
    <main style={{ padding: '2rem', maxWidth: 720 }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>agent-crm</h1>
      <p style={{ color: 'var(--text-3)', marginBottom: '1.5rem' }}>Pick a workspace.</p>
      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rows.map((w) => (
          <li key={w.id} style={{ marginBottom: '.5rem' }}>
            <Link href={`/workspace/${w.id}`} style={{ color: 'var(--text)', textDecoration: 'none', display: 'block', padding: '.75rem', border: '1px solid var(--border)', borderRadius: 6 }}>
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
