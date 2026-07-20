import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
async function main() {
  const sb = createServerClient();
  const { data } = await sb.from('workspaces').select('about, policy').eq('id', 'e7052848-2270-41ac-90b6-d9b75c87f6d3').single();
  const p = (data as any)?.policy ?? {};
  console.log('ABOUT:', ((data as any)?.about ?? '').slice(0, 600));
  console.log('\nGUIDANCE:', p.research?.guidance ?? '(none)');
  console.log('\nALWAYS_INCLUDE:', JSON.stringify(p.research?.always_include ?? []));
  console.log('\nSTRATEGY:', JSON.stringify((p.research?.strategy ?? []).map((a: any) => ({ id: a.id, scope: a.domain_scope, q: a.query_template })), null, 1));
  console.log('\nsearches_per_run:', p.research?.searches_per_run, 'generated_at:', p.research?.strategy_generated_at);
}
main().catch((e) => { console.error(e); process.exit(1); });
