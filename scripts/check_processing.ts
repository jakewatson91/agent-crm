/**
 * Verify the Inngest event flow by counting downstream artifacts in the last hour:
 * channel posts, facts asserted, and any errors. If the recovery worked, these
 * should be growing in real-time.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace');
  const WS = ws.data.id as string;

  // channel_posts has no workspace_id; join through channels.
  const wsChannelsRes = await sb.from('channels').select('id').eq('workspace_id', WS);
  const wsChannelIds = ((wsChannelsRes.data ?? []) as Array<{ id: string }>).map((c) => c.id);

  for (const mins of [10, 60]) {
    const since = new Date(Date.now() - mins * 60 * 1000).toISOString();
    const [posts, facts, events] = await Promise.all([
      sb.from('channel_posts').select('kind').in('channel_id', wsChannelIds).gte('created_at', since).limit(10000),
      sb.from('facts').select('id').eq('workspace_id', WS).gte('created_at', since).limit(10000),
      sb.from('events').select('action').eq('workspace_id', WS).gte('created_at', since).limit(10000),
    ]);
    if (posts.error) console.log(`  posts query err: ${posts.error.message}`);
    if (facts.error) console.log(`  facts query err: ${facts.error.message}`);
    if (events.error) console.log(`  events query err: ${events.error.message}`);
    const postsByKind = new Map<string, number>();
    for (const p of (posts.data ?? []) as Array<{ kind: string }>) {
      postsByKind.set(p.kind, (postsByKind.get(p.kind) ?? 0) + 1);
    }
    const eventsByAction = new Map<string, number>();
    for (const e of (events.data ?? []) as Array<{ action: string }>) {
      eventsByAction.set(e.action, (eventsByAction.get(e.action) ?? 0) + 1);
    }
    console.log(`\n=== last ${mins}m ===`);
    console.log(`  facts asserted:    ${facts.data?.length ?? 0}`);
    console.log(`  channel posts:     ${posts.data?.length ?? 0}`);
    for (const [k, v] of [...postsByKind.entries()].sort()) console.log(`    ${k.padEnd(15)} ${v}`);
    console.log(`  events:            ${events.data?.length ?? 0}`);
    for (const [k, v] of [...eventsByAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      console.log(`    ${k.padEnd(20)} ${v}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
