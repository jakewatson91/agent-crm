import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
async function main() {
  const sb = createServerClient();
  const { data: e } = await sb.from('entities').select('id').eq('workspace_id', 'e7052848-2270-41ac-90b6-d9b75c87f6d3').eq('name', 'DramaBox').single();
  const { data } = await sb.from('signals')
    .select('type, body_for_embedding, structured_tags, observed_at')
    .eq('entity_id', (e as any).id)
    .gte('created_at', new Date(Date.now() - 30 * 60_000).toISOString())
    .order('created_at', { ascending: false });
  for (const s of (data ?? []) as any[]) {
    console.log('---', s.type, '| angle:', s.structured_tags?.angle_id, '| url:', s.structured_tags?.url ?? s.structured_tags?.source_url);
    console.log((s.body_for_embedding ?? '').slice(0, 180).replace(/\n/g, ' '));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
