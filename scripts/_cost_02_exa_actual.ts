/**
 * Real billed Exa cost vs the modeled estimate.
 *
 * report.ts prices Exa at exa_per_search × searches. That is a model, and the
 * whole cost argument rests on it, so it is worth checking against what Exa
 * actually billed. Also checks whether the real-cost path can even fire: the
 * digest resolves EXA_SERVICE_API_KEY, and a key stored under any other name is
 * invisible to it.
 *
 * Read-only against Exa's team-management API and the events table.
 *
 * Usage: pnpm tsx scripts/_cost_02_exa_actual.ts [--days 30]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { fetchExaActualCost } from '../packages/tools/src/exa_usage.ts';
import { getPolicy, resolveEnvVar, DEFAULT_PRICING } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const argv = process.argv.slice(2);
let DAYS = 30;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--days') DAYS = Number(argv[++i]) || DAYS;

(async () => {
  const policy = await getPolicy(sb as any, WS);
  const wanted = resolveEnvVar(policy, 'EXA_SERVICE_API_KEY');
  console.log(`the name the digest looks for, EXA_SERVICE_API_KEY: ${wanted ? 'FOUND' : 'not set — digest falls back to the modeled estimate'}`);
  console.log(`other names present in env: ${Object.keys(process.env).filter((k) => k.startsWith('EXA')).join(', ') || 'none'}`);

  const key = wanted ?? process.env.EXA_SERVICE_KEY;
  if (!key) { console.log('\nno service key available under any name — cannot read real cost'); return; }

  const until = new Date();
  const since = new Date(Date.now() - DAYS * 86400 * 1000);
  const r = await fetchExaActualCost(key, since.toISOString(), until.toISOString());
  console.log(`\nreal billed (all keys on the account): ${r.ok ? `$${(r.totalCostUsd ?? 0).toFixed(2)} across ${r.keysCounted} key(s)` : `FAILED — ${r.error}`}`);

  const sinceIso = since.toISOString();
  const { data } = await sb.from('events').select('payload')
    .eq('workspace_id', WS).eq('action', 'research_completed').gte('created_at', sinceIso).limit(5000);
  const searches = (data ?? []).reduce((n: number, e: any) => n + (e.payload?.searches ?? 0), 0);
  console.log(`modeled for this workspace: $${(searches * DEFAULT_PRICING.exa_per_search).toFixed(2)} (${searches} searches x $${DEFAULT_PRICING.exa_per_search})`);
  console.log('\nnote: real is account-wide across every workspace and every script run; modeled is this workspace only. They are not expected to match exactly.');
})();
