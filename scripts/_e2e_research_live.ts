import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runEntityResearch } from '../inngest/functions/research.ts';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function main() {
  const name = process.argv[2] ?? 'StarSling';
  const ent = await sb.from('entities').select('id, name, attributes').eq('workspace_id', WS).eq('name', name).maybeSingle();
  if (!ent.data) { console.log('entity not found:', name); process.exit(1); }
  console.log(`research → ${ent.data.name} (domain=${(ent.data.attributes as any)?.domain ?? 'NULL'})`);
  const r = await runEntityResearch(sb as any, {
    workspace_id: WS,
    entity_id: ent.data.id,
    entity_name: ent.data.name,
    reason: 'e2e-verify',
  });
  console.log(JSON.stringify(r, null, 2));

  // show what was created
  const sigs = await sb.from('signals')
    .select('id, structured_tags, body_snippet:body_for_embedding')
    .eq('workspace_id', WS).eq('entity_id', ent.data.id).eq('type', 'research_result')
    .gte('observed_at', new Date(Date.now() - 10 * 60_000).toISOString());
  for (const s of (sigs.data ?? []) as any[]) {
    console.log(`  + [${s.structured_tags?.research_angle}] ${s.structured_tags?.url}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
