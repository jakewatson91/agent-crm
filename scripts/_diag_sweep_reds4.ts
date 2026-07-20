import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

async function main() {
  const { data: pol } = await sb.from('workspaces').select('policy').eq('id', ws).maybeSingle();
  console.log('policy.scorable_types =', JSON.stringify((pol?.policy as any)?.scorable_types ?? '(unset -> default [account])'));

  const targets: Record<string, string> = {
    Fresha: '1e044f27-69fb-4905-ba10-ec9122002663',
    Lightspeed: 'd578cabf-2c10-426d-bd0e-d35943bc2563',
  };
  for (const [name, id] of Object.entries(targets)) {
    const { data: isa } = await sb.from('facts').select('object_text, supersedes, id').eq('workspace_id', ws).eq('subject_entity', id).eq('predicate', 'is_a');
    const sup = new Set((isa ?? []).map((r) => r.supersedes).filter(Boolean));
    const active = (isa ?? []).filter((r) => !sup.has(r.id)).map((r) => r.object_text);
    const { count: factCount } = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('subject_entity', id).is('supersedes', null);
    const { data: drop } = await sb.from('facts').select('object_text').eq('workspace_id', ws).eq('subject_entity', id).eq('predicate', 'dropped_until').is('supersedes', null);
    // predicate histogram
    const { data: allf } = await sb.from('facts').select('predicate').eq('workspace_id', ws).eq('subject_entity', id).is('supersedes', null).limit(2000);
    const hist = new Map<string, number>();
    for (const f of allf ?? []) hist.set(f.predicate, (hist.get(f.predicate) ?? 0) + 1);
    const topPreds = [...hist].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([p, c]) => `${p}:${c}`);
    console.log(`\n${name} (${id.slice(0, 8)})`);
    console.log(`  active is_a       = ${JSON.stringify(active)}`);
    console.log(`  dropped_until     = ${JSON.stringify((drop ?? []).map((d) => d.object_text))}`);
    console.log(`  total active facts= ${factCount}`);
    console.log(`  top predicates    = ${topPreds.join('  ')}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
