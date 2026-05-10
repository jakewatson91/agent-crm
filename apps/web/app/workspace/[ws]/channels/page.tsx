import Link from 'next/link';
import { createServerClient } from '@agent-crm/db';
import { Timestamp } from '../../../_components/Timestamp';

export const dynamic = 'force-dynamic';

type ChannelRow = { id: string; title: string; account_entity_id: string; created_at: string };
type PostRow = { channel_id: string; kind: string; body: string; created_at: string };
type FactCount = { subject_entity: string; n: number };
type SignalSource = { entity_id: string; type: string };

const STALE_DAYS = 7;
const DRAFT_PREVIEW_LEN = 160;

function statusFor(latestDraftAt: string | null, latestGateAt: string | null, latestPostAt: string | null): { label: string; color: string } {
  const now = Date.now();
  const draftMs = latestDraftAt ? new Date(latestDraftAt).getTime() : 0;
  const gateMs = latestGateAt ? new Date(latestGateAt).getTime() : 0;
  const postMs = latestPostAt ? new Date(latestPostAt).getTime() : 0;
  if (gateMs > draftMs && gateMs > 0) return { label: 'gated', color: '#e0af68' };
  if (latestDraftAt && (now - draftMs) / 86400000 < STALE_DAYS) return { label: 'draft ready', color: '#9ece6a' };
  if (latestPostAt && (now - postMs) / 86400000 > STALE_DAYS) return { label: 'stale', color: '#666' };
  return { label: 'active', color: '#7aa2f7' };
}

export default async function ChannelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams: Promise<{ filter?: string }>;
}) {
  const { ws } = await params;
  const { filter } = await searchParams;
  const supabase = createServerClient();

  const channelsRes = await supabase
    .from('channels')
    .select('id, title, account_entity_id, created_at')
    .eq('workspace_id', ws)
    .order('created_at', { ascending: false })
    .limit(500);

  const channels = (channelsRes.data ?? []) as ChannelRow[];
  if (!channels.length) {
    return (
      <section>
        <h2 style={{ marginTop: 0 }}>Outreach pipeline</h2>
        <div style={{ marginTop: '2rem', padding: '2rem', border: '1px dashed #1f1f1f', textAlign: 'center', color: '#444' }}>
          No channels yet. Channels are auto-created when an entity gets its first signal.
        </div>
      </section>
    );
  }

  const channelIds = channels.map((c) => c.id);
  const entityIds = channels.map((c) => c.account_entity_id);

  const [draftsRes, gatesRes, lastActivityRes, factCountsRes, signalsRes] = await Promise.all([
    supabase
      .from('channel_posts')
      .select('channel_id, kind, body, created_at')
      .in('channel_id', channelIds)
      .eq('kind', 'touch_draft')
      .order('created_at', { ascending: false })
      .limit(channelIds.length * 3),
    supabase
      .from('channel_posts')
      .select('channel_id, kind, body, created_at')
      .in('channel_id', channelIds)
      .eq('kind', 'gate_request')
      .order('created_at', { ascending: false })
      .limit(channelIds.length * 3),
    supabase
      .from('channel_posts')
      .select('channel_id, created_at')
      .in('channel_id', channelIds)
      .order('created_at', { ascending: false })
      .limit(channelIds.length * 5),
    supabase
      .from('facts')
      .select('subject_entity')
      .in('subject_entity', entityIds)
      .is('supersedes', null),
    supabase
      .from('signals')
      .select('entity_id, type')
      .in('entity_id', entityIds)
      .order('created_at', { ascending: false })
      .limit(entityIds.length * 5),
  ]);

  const latestDraftByChannel = new Map<string, PostRow>();
  for (const r of (draftsRes.data ?? []) as PostRow[]) {
    if (!latestDraftByChannel.has(r.channel_id)) latestDraftByChannel.set(r.channel_id, r);
  }

  const latestGateByChannel = new Map<string, PostRow>();
  for (const r of (gatesRes.data ?? []) as PostRow[]) {
    if (!latestGateByChannel.has(r.channel_id)) latestGateByChannel.set(r.channel_id, r);
  }

  const latestActivityByChannel = new Map<string, string>();
  for (const r of (lastActivityRes.data ?? []) as { channel_id: string; created_at: string }[]) {
    if (!latestActivityByChannel.has(r.channel_id)) latestActivityByChannel.set(r.channel_id, r.created_at);
  }

  const factCountByEntity = new Map<string, number>();
  for (const r of (factCountsRes.data ?? []) as FactCount[]) {
    factCountByEntity.set(r.subject_entity, (factCountByEntity.get(r.subject_entity) ?? 0) + 1);
  }

  const signalTypesByEntity = new Map<string, Set<string>>();
  for (const r of (signalsRes.data ?? []) as SignalSource[]) {
    if (!signalTypesByEntity.has(r.entity_id)) signalTypesByEntity.set(r.entity_id, new Set());
    signalTypesByEntity.get(r.entity_id)!.add(r.type);
  }

  type Row = {
    channel: ChannelRow;
    draft: PostRow | null;
    gate: PostRow | null;
    lastActivity: string | null;
    factCount: number;
    signalTypes: string[];
    status: { label: string; color: string };
  };

  const rows: Row[] = channels.map((c) => {
    const draft = latestDraftByChannel.get(c.id) ?? null;
    const gate = latestGateByChannel.get(c.id) ?? null;
    const lastActivity = latestActivityByChannel.get(c.id) ?? null;
    return {
      channel: c,
      draft,
      gate,
      lastActivity,
      factCount: factCountByEntity.get(c.account_entity_id) ?? 0,
      signalTypes: [...(signalTypesByEntity.get(c.account_entity_id) ?? new Set<string>())],
      status: statusFor(draft?.created_at ?? null, gate?.created_at ?? null, lastActivity),
    };
  });

  rows.sort((a, b) => {
    const at = a.lastActivity ?? a.channel.created_at;
    const bt = b.lastActivity ?? b.channel.created_at;
    return new Date(bt).getTime() - new Date(at).getTime();
  });

  const filtered = filter ? rows.filter((r) => r.status.label === filter) : rows;

  const counts = {
    all: rows.length,
    draft: rows.filter((r) => r.status.label === 'draft ready').length,
    gated: rows.filter((r) => r.status.label === 'gated').length,
    active: rows.filter((r) => r.status.label === 'active').length,
    stale: rows.filter((r) => r.status.label === 'stale').length,
  };

  const filterLink = (key: string | null, label: string, n: number) => (
    <Link
      href={key ? `/workspace/${ws}/channels?filter=${encodeURIComponent(key)}` : `/workspace/${ws}/channels`}
      style={{
        padding: '.25rem .6rem',
        marginRight: '.5rem',
        borderRadius: 4,
        background: filter === key || (!filter && !key) ? '#1f1f1f' : 'transparent',
        border: '1px solid #2a2a2a',
        color: '#e5e5e5',
        textDecoration: 'none',
        fontSize: '.85rem',
      }}
    >
      {label} <span style={{ color: '#666' }}>({n})</span>
    </Link>
  );

  return (
    <section>
      <h2 style={{ marginTop: 0 }}>Outreach pipeline</h2>
      <p style={{ color: '#666', fontSize: '.9rem', marginBottom: '1rem' }}>
        Every entity flagged for outreach. Latest draft preview, status, fact depth, signal sources.
      </p>

      <div style={{ marginBottom: '1.25rem' }}>
        {filterLink(null, 'all', counts.all)}
        {filterLink('draft ready', 'draft ready', counts.draft)}
        {filterLink('gated', 'gated', counts.gated)}
        {filterLink('active', 'active', counts.active)}
        {filterLink('stale', 'stale', counts.stale)}
      </div>

      {filtered.length === 0 ? (
        <div style={{ marginTop: '1rem', padding: '2rem', border: '1px dashed #1f1f1f', textAlign: 'center', color: '#444' }}>
          No channels match this filter.
        </div>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, marginTop: '1rem' }}>
          {filtered.map((r) => (
            <li
              key={r.channel.id}
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
                  <Link
                    href={`/workspace/${ws}/channels/${r.channel.id}`}
                    style={{ color: '#e5e5e5', textDecoration: 'none', fontWeight: 500 }}
                  >
                    {r.channel.title}
                  </Link>
                  <span
                    style={{
                      fontSize: '.7rem',
                      padding: '.1rem .4rem',
                      borderRadius: 3,
                      background: '#0e0e0e',
                      color: r.status.color,
                      border: `1px solid ${r.status.color}33`,
                    }}
                  >
                    {r.status.label}
                  </span>
                  {r.signalTypes.length > 0 && (
                    <span style={{ fontSize: '.7rem', color: '#555' }}>
                      from {r.signalTypes.slice(0, 3).join(', ')}
                      {r.signalTypes.length > 3 ? `, +${r.signalTypes.length - 3}` : ''}
                    </span>
                  )}
                </div>
                {r.draft && (
                  <div
                    style={{
                      marginTop: '.4rem',
                      fontSize: '.85rem',
                      color: '#9aa0a6',
                      whiteSpace: 'pre-wrap',
                      lineHeight: 1.4,
                    }}
                  >
                    {r.draft.body.length > DRAFT_PREVIEW_LEN
                      ? r.draft.body.slice(0, DRAFT_PREVIEW_LEN) + '…'
                      : r.draft.body}
                  </div>
                )}
                {!r.draft && (
                  <div style={{ marginTop: '.4rem', fontSize: '.8rem', color: '#444', fontStyle: 'italic' }}>
                    no draft yet
                  </div>
                )}
              </div>
              <div style={{ textAlign: 'right', fontSize: '.75rem', color: '#666', whiteSpace: 'nowrap' }}>
                <div>{r.factCount} fact{r.factCount === 1 ? '' : 's'}</div>
                {r.lastActivity && (
                  <div style={{ marginTop: '.2rem' }}>
                    <Timestamp value={r.lastActivity} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
