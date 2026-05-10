import { createServerClient } from '@agent-crm/db';

export const dynamic = 'force-dynamic';

export default async function ActivityPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = createServerClient();
  const { data: posts } = await supabase
    .from('channel_posts')
    .select(`
      id, kind, body, cites, author_kind, author_id, created_at,
      channels!inner(workspace_id, title, account_entity_id)
    `)
    .eq('channels.workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(100);

  const items = posts ?? [];
  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Activity</h2>
      <p style={{ color: '#666', fontSize: '.9rem' }}>Ambient feed. You don&apos;t need to read it.</p>
      {items.length === 0 ? (
        <div style={{ marginTop: '2rem', padding: '2rem', border: '1px dashed #1f1f1f', textAlign: 'center', color: '#444' }}>
          No activity yet. Subscriptions will populate this once signals start flowing.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1.5rem' }}>
          {items.map((p) => (
            <li key={p.id} style={{ padding: '.75rem 0', borderBottom: '1px solid #1f1f1f' }}>
              <div style={{ fontSize: '.75rem', color: '#666' }}>
                {p.author_kind}/{p.author_id} · {p.kind} · {new Date(p.created_at).toLocaleString()}
              </div>
              <div style={{ marginTop: '.25rem' }}>{p.body}</div>
              {Array.isArray(p.cites) && p.cites.length > 0 && (
                <div style={{ fontSize: '.7rem', color: '#7aa2f7', marginTop: '.25rem' }}>
                  cites: {p.cites.length}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
