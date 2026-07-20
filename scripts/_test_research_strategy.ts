import { createServerClient } from '@agent-crm/db';
import { generateResearchStrategy, persistResearchStrategy } from '@agent-crm/tools';

const PERSIST = process.argv.includes('--persist');

async function main() {
  const supabase = createServerClient();
  const ws = await supabase.from('workspaces').select('id, name').order('created_at', { ascending: true });
  console.log('workspaces:', ws.data);
  const list = (ws.data ?? []) as Array<{ id: string; name: string }>;
  const target = list.find((w) => w.id.startsWith('af602fa1')) ?? list[0];
  if (!target) { console.log('no workspace'); return; }
  console.log('\nTARGET', target, '\n');
  const r = await generateResearchStrategy(supabase, target.id);
  console.log('source:', r.source, '| error:', r.error ?? 'none', '| angles:', r.angles.length, '\n');
  for (const a of r.angles) {
    console.log(`- [${a.id}] ${a.label}`);
    console.log(`    scope=${a.domain_scope} recency=${a.recency_days ?? '-'} num=${a.num_results ?? '-'}`);
    console.log(`    q: ${a.query_template}`);
  }
  if (PERSIST) {
    await persistResearchStrategy(supabase, target.id, r.angles);
    console.log('\n✓ persisted to workspaces.policy.research.strategy');
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
