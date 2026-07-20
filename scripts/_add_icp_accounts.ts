import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool } from '@agent-crm/tools';

const ACCOUNTS = [
  { name: 'EarthaPro', domain: 'earthapro.com', attrs: { industry: 'B2B', stage: 'Early', team_size: 3, founded_year: 2024, location: 'Haymarket, VA, USA', one_liner: 'All-in-one software for lawn care and landscaping businesses (estimates, scheduling, invoicing).', tags: ['Vertical SaaS', 'SMB', 'Field Services', 'B2B'] } },
  { name: 'Latch', domain: 'golatch.com', attrs: { industry: 'B2B', stage: 'Early', team_size: 4, location: 'USA', one_liner: 'Back-office finance + job costing built for home service contractors (HVAC, roofing, plumbing).', tags: ['Vertical SaaS', 'FinOps', 'SMB', 'Field Services', 'B2B'] } },
  { name: 'TackPilot', domain: 'tackpilot.com', attrs: { industry: 'B2B', stage: 'Early', team_size: 2, founded_year: 2025, location: 'USA', one_liner: 'Ops command center for general contractors, built by a GC with an enterprise-sales background.', tags: ['Vertical SaaS', 'Construction', 'SMB', 'B2B'] } },
  { name: 'Ottomatiq', domain: 'ottomatiq.com', attrs: { industry: 'B2B', stage: 'Early', team_size: 3, founded_year: 2023, location: 'Montreal, Canada', one_liner: 'Simple invoicing, billing and payment tracking for small service businesses and wellness practices.', tags: ['Vertical SaaS', 'SMB', 'Services', 'B2B'] } },
  { name: 'TrueRev', domain: 'truerev.com', attrs: { industry: 'B2B', stage: 'Seed', team_size: 6, founded_year: 2019, location: 'San Mateo, CA, USA', one_liner: 'FinOps SaaS automating revenue recognition and SaaS metrics for B2B SaaS finance teams.', tags: ['Vertical SaaS', 'FinOps', 'B2B SaaS', 'B2B'] } },
];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'source:exa:icp-test' };
  // existing domains
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const have = new Set(ents.map((e) => String(e.attributes?.domain ?? '').toLowerCase()).filter(Boolean));
  let created = 0;
  for (const a of ACCOUNTS) {
    if (have.has(a.domain)) { console.log(`exists  ${a.name} (${a.domain})`); continue; }
    const r = await callTool(sb, actor, 'create_account', { name: a.name, attributes: { domain: a.domain, _discovered_via: 'exa_icp_test', discovered_at: new Date().toISOString(), ...a.attrs } });
    console.log(`${r.ok ? 'CREATED' : 'FAILED '} ${a.name.padEnd(12)} ${a.domain}  ${r.ok ? '' : (r as any).error}`);
    if (r.ok) created++;
  }
  console.log(`\ncreated ${created} ICP test accounts`);
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
