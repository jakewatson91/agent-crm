/**
 * Pick a recent signal, run match_signal_to_subscriptions directly, see what it returns.
 * Pinpoints whether the matcher logic is the issue (vs the trigger/queue not firing).
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

  const sigs = await sb.from('signals')
    .select('id, type, structured_tags, body_for_embedding, created_at')
    .eq('workspace_id', ws.data.id as string)
    .order('created_at', { ascending: false }).limit(3);

  for (const s of (sigs.data ?? []) as Array<any>) {
    console.log(`\n=== signal ${(s.id as string).slice(0, 8)}… type=${s.type} ===`);
    console.log(`  tags: ${JSON.stringify(s.structured_tags)}`);
    console.log(`  body: ${(s.body_for_embedding as string)?.slice(0, 80) ?? ''}`);
    const { data, error } = await sb.rpc('match_signal_to_subscriptions', { p_signal_id: s.id });
    if (error) {
      console.log(`  ✗ rpc error: ${error.code} ${error.message}`);
      continue;
    }
    const matches = (data ?? []) as Array<{ subscription_id: string; owner_id: string; similarity: number }>;
    console.log(`  matches: ${matches.length}`);
    for (const m of matches.slice(0, 5)) console.log(`    ${m.similarity.toFixed(3)}  ${m.owner_id}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
