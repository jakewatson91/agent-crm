import Link from 'next/link';
import { createServerClient } from '@agent-crm/db';
import { listEntities, type EntityStatus } from '@agent-crm/tools';
import { Timestamp } from '../../../_components/Timestamp';

export const dynamic = 'force-dynamic';

const DRAFT_PREVIEW_LEN = 160;

const STATUS_COLORS: Record<EntityStatus, string> = {
  draft_ready: '#9ece6a',
  gated: '#e0af68',
  active: '#7aa2f7',
  stale: '#666',
  no_signals: '#444',
};

export default async function OutreachAuditPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const supabase = createServerClient();

  // Same code path the agent uses via the list_entities MCP tool.
  const entries = await listEntities(supabase, ws, { limit: 200 });

  // Pull most-recent draft body for each entity for the audit preview only.
  // (Agents calling list_entities don't need this; they'd call get_entity for full text.)
  const channelIds = entries.map((e) => e.channel_id).filter((c): c is string => !!c);
  const draftBodies = new Map<string, string>();
  if (channelIds.length) {
    const drafts = await supabase
      .from('channel_posts')
      .select('channel_id, body, created_at')
      .in('channel_id', channelIds)
      .eq('kind', 'touch_draft')
      .order('created_at', { ascending: false })
      .limit(channelIds.length * 2);
    for (const d of (drafts.data ?? []) as Array<{ channel_id: string; body: string }>) {
      if (!draftBodies.has(d.channel_id)) draftBodies.set(d.channel_id, d.body);
    }
  }

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Feed</h2>
      <p style={{ color: '#666', fontSize: '.85rem', marginBottom: '1.25rem' }}>
        What the agent has been doing. Same data the agent sees via the <code>list_entities</code> MCP tool.
        Click a row to walk provenance.
      </p>

      {entries.length === 0 ? (
        <div style={{ marginTop: '2rem', padding: '2rem', border: '1px dashed #1f1f1f', textAlign: 'center', color: '#444' }}>
          No entities yet. Wait for the next cron tick or run a source manually.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1rem' }}>
          {entries.map((e) => {
            const draftBody = e.channel_id ? draftBodies.get(e.channel_id) : null;
            return (
              <li
                key={e.entity_id}
                style={{
                  padding: '.85rem 0',
                  borderBottom: '1px solid #1f1f1f',
                  display: 'grid',
                  gridTemplateColumns: '1fr auto',
                  gap: '.5rem',
                }}
              >
                <div>
                  <div style={{ display: 'flex', gap: '.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
                    {e.channel_id ? (
                      <Link href={`/workspace/${ws}/channels/${e.channel_id}`} style={{ color: '#e5e5e5', textDecoration: 'none', fontWeight: 500 }}>
                        {e.name}
                      </Link>
                    ) : (
                      <span style={{ color: '#e5e5e5', fontWeight: 500 }}>{e.name}</span>
                    )}
                    <span
                      style={{
                        fontSize: '.7rem',
                        padding: '.1rem .4rem',
                        borderRadius: 3,
                        background: '#0e0e0e',
                        color: STATUS_COLORS[e.status],
                        border: `1px solid ${STATUS_COLORS[e.status]}33`,
                      }}
                    >
                      {e.status.replace('_', ' ')}
                    </span>
                    {e.signal_types.length > 0 && (
                      <span style={{ fontSize: '.7rem', color: '#555' }}>
                        from {e.signal_types.slice(0, 3).join(', ')}
                        {e.signal_types.length > 3 ? `, +${e.signal_types.length - 3}` : ''}
                      </span>
                    )}
                  </div>
                  {e.top_contact && (
                    <div style={{ marginTop: '.25rem', fontSize: '.75rem', color: '#7aa2f7' }}>
                      → {e.top_contact.name} <span style={{ color: '#666' }}>&lt;{e.top_contact.email}&gt;</span>
                      {e.top_contact.role && <span style={{ color: '#555' }}> · {e.top_contact.role}</span>}
                    </div>
                  )}
                  {draftBody && (
                    <div style={{ marginTop: '.4rem', fontSize: '.8rem', color: '#9aa0a6', whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>
                      {draftBody.length > DRAFT_PREVIEW_LEN ? draftBody.slice(0, DRAFT_PREVIEW_LEN) + '…' : draftBody}
                    </div>
                  )}
                  {!draftBody && e.has_draft === false && (
                    <div style={{ marginTop: '.4rem', fontSize: '.75rem', color: '#444', fontStyle: 'italic' }}>
                      no draft yet
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right', fontSize: '.7rem', color: '#666', whiteSpace: 'nowrap' }}>
                  <div>{e.fact_count} fact{e.fact_count === 1 ? '' : 's'}</div>
                  {e.latest_activity && (
                    <div style={{ marginTop: '.2rem' }}>
                      <Timestamp value={e.latest_activity} />
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
