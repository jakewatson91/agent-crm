import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name','demo · agent-crm%').order('created_at',{ascending:false}).limit(1).single();
  const channel = await sb.from('channels').select('id, title').eq('workspace_id', ws.data!.id).eq('title','Resona Labs').single();
  const fact = await sb.from('facts').select('id, predicate, object_text').eq('workspace_id', ws.data!.id).limit(1).single();

  console.log('\n=== /api/channels/[channel]/timeline ===');
  const t = await fetch(`http://localhost:3000/api/channels/${channel.data!.id}/timeline`).then((r) => r.json());
  console.log(`  entity: ${t.entity?.name}`);
  console.log(`  counts: signals=${t.counts.signals}, facts=${t.counts.facts}, posts=${t.counts.posts}, gates=${t.counts.gates}`);
  console.log(`  first 6 items:`);
  for (const i of (t.items ?? []).slice(0, 6)) {
    console.log(`    [${i.kind.padEnd(6)}] ${i.summary.slice(0, 90)}`);
  }

  console.log('\n=== /api/facts/[id]/chain ===');
  const c = await fetch(`http://localhost:3000/api/facts/${fact.data!.id}/chain`).then((r) => r.json());
  console.log(`  fact: ${fact.data!.predicate}=${fact.data!.object_text}`);
  console.log(`  hops: ${c.hop_count}`);
  for (const h of c.hops ?? []) {
    const f = h.fact ?? {};
    const e = h.source_event ?? {};
    console.log(`    ${f.predicate ?? '?'}=${f.object_text ?? '?'}  via event ${e.id ?? '?'} (${e.action ?? '?'} by ${e.actor_id ?? '?'})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
