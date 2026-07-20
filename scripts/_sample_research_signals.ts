import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const sigs = await sb.from('signals')
    .select('id,entity_id,type,observed_at,body_for_embedding,structured_tags')
    .eq('workspace_id', ws)
    .eq('type', 'research_result')
    .gte('observed_at', since)
    .order('observed_at', { ascending: false })
    .limit(10);
  if (sigs.error) throw sigs.error;
  console.log(`total research_result signals sampled: ${sigs.data?.length}`);
  for (const s of sigs.data ?? []) {
    console.log('---');
    console.log('url:', (s.structured_tags as any)?.url);
    console.log('body:', (s.body_for_embedding as string)?.slice(0, 400));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
