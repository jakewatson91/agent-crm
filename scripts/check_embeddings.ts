import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const ents = await sb
    .from('entities')
    .select('id, name, attributes')
    .eq('workspace_id', ws.data!.id)
    .eq('kind', 'account')
    .filter('attributes->>yc_batch', 'in', '("Summer 2025","Winter 2025")');
  console.log(`YC entities (W25 or S25): ${ents.data?.length ?? 0}`);
  for (const e of ents.data ?? []) {
    const emb = await sb.from('entity_embeddings').select('perspective').eq('entity_id', e.id);
    const has = (emb.data ?? []).map((r) => r.perspective).join(',');
    console.log(`  ${(e.name as string).padEnd(20)} batch=${(e.attributes as any).yc_batch.padEnd(15)} embeddings=[${has}]`);
  }
}
main();
