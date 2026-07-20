import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function main() {
  const since24 = new Date(Date.now() - 24 * 3600_000).toISOString();

  // drafts last 24h with their account
  const drafts = await sb.from('channel_posts')
    .select('id, body, created_at, channel_id, channels!inner(workspace_id, account_entity_id)')
    .eq('channels.workspace_id', WS)
    .eq('kind', 'touch_draft')
    .gte('created_at', since24)
    .order('created_at', { ascending: false });
  if (drafts.error) console.log('drafts err:', drafts.error.message);
  const chAcct = new Map<string, string>();
  for (const d of (drafts.data ?? []) as any[]) chAcct.set(d.channel_id, d.channels.account_entity_id);
  const acctIds = [...new Set([...chAcct.values()])];
  const ents = await sb.from('entities').select('id, name').in('id', acctIds);
  const nameById = new Map((ents.data ?? []).map((e: any) => [e.id, e.name]));
  console.log(`── touch_drafts last 24h: ${drafts.data?.length}`);
  for (const d of ((drafts.data ?? []) as any[]).slice(0, 6)) {
    console.log(`\n=== ${nameById.get(d.channels.account_entity_id)} [${d.created_at}]`);
    console.log(String(d.body ?? '').slice(0, 500));
  }

  // pending gates
  const gates = await sb.from('gates').select('id, decision, created_at, channel_post_id').eq('workspace_id', WS).is('decision', null).order('created_at', { ascending: false });
  if (gates.error) console.log('gates err:', gates.error.message);
  console.log(`\n── pending gates: ${gates.data?.length}`);

  // facts on PathPilot + Embedder (last 48h) with provenance snippets
  const targets = await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).in('name', ['PathPilot', 'Embedder']);
  for (const t of (targets.data ?? []) as any[]) {
    console.log(`\n── ${t.name} (domain=${t.attributes?.domain ?? 'NULL'}) facts last 48h:`);
    const fs = await sb.from('facts')
      .select('predicate, object_text, created_at, source_event_id')
      .eq('workspace_id', WS)
      .eq('subject_entity', t.id)
      .gte('created_at', new Date(Date.now() - 48 * 3600_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(30);
    for (const f of (fs.data ?? []) as any[]) {
      if (f.predicate.startsWith('score_') || f.predicate.endsWith('_breakdown')) continue;
      console.log(`   ${f.predicate}: ${String(f.object_text).slice(0, 130)}`);
    }
  }

  // enricher yield: research_result signals last 24h → how many produced ≥1 fact?
  const rsig = await sb.from('signals')
    .select('id, entity_id, source_event_id')
    .eq('workspace_id', WS).eq('type', 'research_result')
    .gte('observed_at', since24).limit(1000);
  const sigIds = (rsig.data ?? []).map((s: any) => s.id);
  console.log(`\n── research signals 24h: ${sigIds.length}`);
  // agent_dispatch_result events carry facts_asserted
  const ev = await sb.from('events')
    .select('action, payload, created_at')
    .eq('workspace_id', WS)
    .eq('action', 'agent_dispatch_result')
    .gte('created_at', since24)
    .limit(2000);
  let withFacts = 0, zero = 0, totalFacts = 0;
  for (const e of (ev.data ?? []) as any[]) {
    const fa = e.payload?.facts_asserted ?? 0;
    if (fa > 0) { withFacts++; totalFacts += fa; } else zero++;
  }
  console.log(`── agent_dispatch_result 24h: ${ev.data?.length} (facts>0: ${withFacts}, zero: ${zero}, total facts: ${totalFacts})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
