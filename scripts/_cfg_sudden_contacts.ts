// #4 config: Sudden contact throughput — explorium primary (better hit rate on
// this book, Hunter's ~39 credits stay reserved), hunter fallback, 16 pulls/run.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const enrichment = {
    ...((policy.enrichment as Record<string, unknown>) ?? {}),
    contact_provider: 'explorium',
    contact_provider_fallback: 'hunter',
    max_contact_pulls_per_run: 16,
  };
  const { error: upErr } = await sb.from('workspaces').update({ policy: { ...policy, enrichment } }).eq('id', WS);
  if (upErr) throw upErr;
  console.log('Sudden enrichment: provider=explorium fallback=hunter max_pulls=16');
}
main().catch((e) => { console.error(e); process.exit(1); });
