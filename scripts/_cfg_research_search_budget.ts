// Set policy.research.searches_per_run on the Sudden workspace.
//
// This is the main Exa cost dial. The dispatcher cron fires every 4 hours
// (RESEARCH_DISPATCH_CRON = '0 */4 * * *', 6x/day) and spends up to this many
// Exa searches per fire, so daily Exa spend is roughly 6 x this x $0.007.
//
// Measured 2026-08-16 over 14 days at the default of 30: 2,241 searches
// ($15.69) bought 890 kept facts, but 60% of runs produced nothing at all and
// exactly 1 research fact was cited in a draft. Cutting the budget costs very
// little real signal.
//
// Usage: pnpm tsx scripts/_cfg_research_search_budget.ts [n]
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const N = Number(process.argv[2] ?? '8');

async function main() {
  const { data, error } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (error) throw error;
  const policy = (data?.policy ?? {}) as Record<string, unknown>;
  const prev = (policy.research as Record<string, unknown>)?.searches_per_run ?? '(unset -> default 30)';
  const research = { ...((policy.research as Record<string, unknown>) ?? {}), searches_per_run: N };
  const { error: upErr } = await sb.from('workspaces').update({ policy: { ...policy, research } }).eq('id', WS);
  if (upErr) throw upErr;
  console.log(`Sudden research.searches_per_run: ${prev} -> ${N}`);
  console.log(`  ceiling now ~${6 * N} searches/day = $${(6 * N * 0.007).toFixed(2)}/day = $${(6 * N * 0.007 * 7).toFixed(2)}/week`);
}
main().catch((e) => { console.error(e); process.exit(1); });
