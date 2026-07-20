import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const wsRow = ((await sb.from('workspaces').select('id, about, icp')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!;
  const ws = wsRow.id as string;

  // PRIMARY ICP: tiny-team / pre-sales-hire founder (matches the dogfood thesis).
  // Secondary segment tracked in a field the scorer ignores, so it doesn't blur the profile.
  const icp = {
    industry: 'b2b',
    headcount: '1-20',
    pain: [
      'no dedicated salesperson — the founder runs sales',
      'manual outbound, no time for prospecting',
      'needs more customers but cannot hire a sales team yet',
      'wants an agent to run outbound end-to-end',
    ],
    stack: [],
    buyer: 'early-stage B2B company in any vertical with a tiny team doing founder-led sales, pre first sales hire',
    secondary_segment: 'AI-forward B2B SaaS (10-200) frustrated with HubSpot/Salesforce — second segment, not primary',
  };

  const about = (wsRow.about ?? '').split('\n\nWHO WE SELL TO')[0].trim() +
    '\n\nWHO WE SELL TO (primary): early-stage B2B companies, any vertical, with a tiny team (1-20) and no dedicated salesperson — the founder does sales manually and wants an agent to run outbound end-to-end. Secondary segment: AI-forward B2B SaaS (10-200) frustrated with legacy CRMs.';

  await sb.from('workspaces').update({ icp, about }).eq('id', ws);
  console.log('ICP updated to primary=tiny-team; secondary segment noted. workspace.updated_at bumped (cron will refresh the rest).\n');

  const DOMAINS = ['earthapro.com', 'golatch.com', 'tackpilot.com', 'ottomatiq.com', 'truerev.com'];
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const byDomain = new Map(ents.map((e) => [String(e.attributes?.domain ?? '').toLowerCase(), e]));
  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'system:scorer' };
  console.log('=== re-scored against tiny-team ICP ===');
  for (const d of DOMAINS) {
    const e = byDomain.get(d);
    const s = await scoreAndAssert(sb, actor, e.id);
    if (!s) { console.log(`  ${e.name.padEnd(12)} skipped (stale-guard — assert a fact to force)`); continue; }
    const b = s.breakdown;
    console.log(`  ${e.name.padEnd(12)} icp_total=${s.icp_total.toFixed(2)}  industry=${b.industry_match.toFixed(2)} stage=${b.stage_match.toFixed(2)} signal=${b.signal_strength.toFixed(2)}`);
  }
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
