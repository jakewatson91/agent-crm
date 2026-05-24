import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const WS = ws.data!.id as string;

  const rows = await sb.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit').is('supersedes', null);
  const scores = ((rows.data ?? []) as Array<{ object_text: string }>).map((r) => parseFloat(r.object_text)).filter((v) => Number.isFinite(v));
  console.log(`scored entities: ${scores.length}`);
  if (!scores.length) return;

  const deciles = new Array(10).fill(0);
  for (const s of scores) deciles[Math.min(9, Math.max(0, Math.floor(s * 10)))] += 1;
  const max = Math.max(...deciles);
  console.log('\ndistribution by decile (icp_fit):');
  deciles.forEach((n, i) => {
    const bar = '█'.repeat(Math.round((n / max) * 40));
    const pct = ((n / scores.length) * 100).toFixed(0).padStart(3);
    console.log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}  ${String(n).padStart(3)}  ${pct}%  ${bar}`);
  });
  const peakIdx = deciles.indexOf(max);
  console.log(`\npeak decile: ${peakIdx}/10 with ${((max / scores.length) * 100).toFixed(0)}% (sweep red threshold: >60%)`);
}
main();
