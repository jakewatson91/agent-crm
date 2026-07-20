// Set policy.research.domain_backfill_per_day on the Sudden workspace.
// Per the 2026-07-17 Exa budget decision: 75/day (~$0.75/day at 3-result
// resolver params), clears the ~1.9K domainless backlog in ~24 days.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const PER_DAY = Number(process.argv[2] ?? '75');

async function main() {
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const research = { ...((policy.research as Record<string, unknown>) ?? {}), domain_backfill_per_day: PER_DAY };
  const { error: upErr } = await sb.from('workspaces').update({ policy: { ...policy, research } }).eq('id', WS);
  if (upErr) throw upErr;
  console.log(`Sudden research.domain_backfill_per_day = ${PER_DAY}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
