import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

// Flip policy.enrichment.resolve_entities on af602fa1. Merges (does not clobber
// other enrichment fields). Pass "off" to disable.
const ON = process.argv[2] !== 'off';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id, name')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const cur = ((await sb.from('workspaces').select('policy').eq('id', ws).single()).data?.policy ?? {}) as Record<string, any>;
  console.log('before enrichment:', JSON.stringify(cur.enrichment ?? {}));
  const policy = { ...cur, enrichment: { ...(cur.enrichment ?? {}), resolve_entities: ON } };
  const { error } = await sb.from('workspaces').update({ policy }).eq('id', ws);
  if (error) throw error;
  const after = ((await sb.from('workspaces').select('policy').eq('id', ws).single()).data?.policy ?? {}) as Record<string, any>;
  console.log('after enrichment: ', JSON.stringify(after.enrichment ?? {}));
  console.log(`resolve_entities = ${after.enrichment?.resolve_entities}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
