import Link from 'next/link';
import { createServerClient } from '@agent-crm/db';

export const dynamic = 'force-dynamic';

export default async function ChannelsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = createServerClient();
  const { data } = await supabase
    .from('channels')
    .select('id, title, account_entity_id, created_at')
    .eq('workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(100);

  const channels = data ?? [];
  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Channels</h2>
      <p style={{ color: '#666', fontSize: '.9rem' }}>One channel per account. Auto-created when an account is.</p>
      {channels.length === 0 ? (
        <div style={{ marginTop: '2rem', padding: '2rem', border: '1px dashed #1f1f1f', textAlign: 'center', color: '#444' }}>
          No channels yet.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1.5rem' }}>
          {channels.map((c) => (
            <li key={c.id} style={{ padding: '.5rem 0', borderBottom: '1px solid #1f1f1f' }}>
              <Link href={`/workspace/${ws}/channels/${c.id}`} style={{ color: '#e5e5e5', textDecoration: 'none' }}>
                {c.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
