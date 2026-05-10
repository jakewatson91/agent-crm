/**
 * Verify migration 0016: pick a random entity, call find_similar_entities, print results.
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
  const ws = await sb.from('workspaces').select('id, name')
    .like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  if (ws.error || !ws.data) throw new Error('no demo workspace');
  const WS = ws.data.id as string;

  const ent = await sb.from('entities').select('id, name').eq('workspace_id', WS).limit(1).single();
  if (ent.error || !ent.data) throw new Error('no entity to test against');
  console.log(`source entity: ${ent.data.name} (${(ent.data.id as string).slice(0, 8)}…)\n`);

  const { data, error } = await sb.rpc('find_similar_entities', {
    p_workspace_id: WS,
    p_entity_id: ent.data.id,
    p_top_k: 5,
    p_perspective: null,
  });
  if (error) {
    console.log(`✗ RPC error: ${error.code} ${error.message}`);
    if (error.code === 'PGRST202') console.log('  → migration 0016 not applied yet');
    process.exit(1);
  }
  console.log('✓ RPC works. top 5 similar entities:');
  for (const r of (data ?? []) as Array<{ name: string; similarity: number }>) {
    console.log(`  ${r.similarity.toFixed(3)}  ${r.name}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
