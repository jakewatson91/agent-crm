/**
 * The per-source scorer subscriptions (yc_*_scorer, web_intent_scorer, etc.)
 * are superseded by the universal scoreAndAssert post-enrichment hook in
 * agent_logic.ts. Scoring is workspace-wide / source-agnostic now.
 *
 * Deactivates them to stop redundant claim_poster runs (and the token cost).
 * Reversible: set active=true on any row to bring it back.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const LEGACY_SCORER_OWNERS = [
  'claims_yc_companies_icp_fit_scoring',
  'claims_audit_yc_scorer',
  'claims_yc_icp_fit_scorer',
  'claims_web_intent_scorer',
  'claims_icp_fit_scoring',  // b2b_saas_hiring_engineers
];

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%')
    .order('created_at', { ascending: false }).limit(1).single();
  if (!ws.data) throw new Error('no workspace');
  const WS = ws.data.id as string;

  const subs = await sb.from('subscriptions')
    .select('id, name, owner_id, active')
    .eq('workspace_id', WS).in('owner_id', LEGACY_SCORER_OWNERS);

  let deactivated = 0;
  for (const s of (subs.data ?? []) as Array<{ id: string; name: string; owner_id: string; active: boolean }>) {
    if (!s.active) { console.log(`  [skip] ${s.name} already off`); continue; }
    const upd = await sb.from('subscriptions').update({ active: false }).eq('id', s.id);
    if (upd.error) { console.log(`  [err]  ${s.name}: ${upd.error.message}`); continue; }
    console.log(`  [off]  ${s.name}`);
    deactivated++;
  }
  console.log(`\n${deactivated} subscription(s) deactivated. Universal scoreAndAssert handles ICP scoring now.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
