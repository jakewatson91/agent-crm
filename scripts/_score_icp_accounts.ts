import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

const DOMAINS = ['earthapro.com', 'golatch.com', 'tackpilot.com', 'ottomatiq.com', 'truerev.com'];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wsRow = ((await sb.from('workspaces').select('id, about, icp')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!;
  const ws = wsRow.id as string;
  console.log('=== workspace ABOUT ==='); console.log((wsRow.about ?? '(none)').slice(0, 400));
  console.log('\n=== workspace ICP ==='); console.log(JSON.stringify(wsRow.icp ?? {}, null, 1).slice(0, 500));

  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const byDomain = new Map(ents.map((e) => [String(e.attributes?.domain ?? '').toLowerCase(), e]));
  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'system:scorer' };

  console.log('\n=== scoring 5 ICP accounts ===');
  for (const d of DOMAINS) {
    const e = byDomain.get(d); if (!e) { console.log(`  ${d}: no entity`); continue; }
    const s = await scoreAndAssert(sb, actor, e.id);
    if (!s) { console.log(`  ${e.name.padEnd(12)} skipped (gated)`); continue; }
    const b = s.breakdown;
    console.log(`  ${e.name.padEnd(12)} icp_total=${s.icp_total.toFixed(2)}  industry=${b.industry_match.toFixed(2)} stage=${b.stage_match.toFixed(2)} signal=${b.signal_strength.toFixed(2)} rrf=${b.rrf_prefilter.toFixed(2)}`);
  }
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
