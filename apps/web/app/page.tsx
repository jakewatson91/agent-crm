import { redirect } from 'next/navigation';
import { createServerClient } from '@agent-crm/db';

export const dynamic = 'force-dynamic';

/**
 * Single-tenant dog-food deployment. No auth UI built yet. Pick the first
 * (most recent) workspace and redirect there. If you add multi-tenant later,
 * this becomes a workspace picker or login page.
 */
export default async function Home() {
  const sb = createServerClient();
  const ws = await sb.from('workspaces').select('id, name')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (ws.data?.id) {
    redirect(`/workspace/${ws.data.id}/gates`);
  }
  return (
    <main style={{ padding: '2rem', maxWidth: 720 }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>agent-crm</h1>
      <p style={{ color: '#999' }}>No workspaces yet.</p>
    </main>
  );
}
