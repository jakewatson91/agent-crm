import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool, scoreAndAssert, linkContactByProspectId, loadBestContactScore, selectAction, buildThresholds, loadActionContext, getPolicy } from '@agent-crm/tools';

const ROWS = [
  { domain: 'earthapro.com', contact: { name: 'Courtney Krstich', role: 'Co-founder (field-sales background)', linkedin_url: 'linkedin.com/in/ACoAACCM4qMB3hG8UW1Wzz4IRmxlRAf78s7FaJk', prospect_id: '2ff2798ec7c7524be6e7664bbc571f581e9bba4f' },
    signal: 'EarthaPro is a 3-person startup selling software to small landscaping and lawn-care businesses. Co-founder Courtney Krstich has a deep field-sales background (channel/district sales, cold calling). They reach customers manually — booth at the Arett Sales trade show, featured in Lawn & Landscape. Tiny team running founder-led outbound, no dedicated sales hire. [source: earthapro.com / Lawn & Landscape]' },
  { domain: 'ottomatiq.com', contact: { name: 'Zachary Melnik', role: 'Co-Founder' },
    signal: 'Ottomatiq is a 3-person startup selling simple invoicing to small service businesses and wellness practices. Founder-led growth across a niche SMB market; no dedicated sales team. [source: ottomatiq.com]' },
  { domain: 'truerev.com', contact: { name: 'Ali Rizvi', role: 'Founder, CEO & CFO' },
    signal: 'TrueRev is a 6-person FinOps SaaS for B2B SaaS finance teams; founder Ali Rizvi is the sole CEO/CFO. Publishing B2B SaaS tech-stack reports to attract finance leaders; small team selling to other startups with no dedicated sales hire. [source: truerev.com]' },
  { domain: 'tackpilot.com', contact: { name: 'William Smith', role: 'CEO' },
    signal: 'TackPilot is a 2-person startup building ops software for general contractors. Founder is a GC with an enterprise-sales background, selling directly to contractors; no sales team. [source: tackpilot.com]' },
];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'source:exa:loop' };
  const policy = await getPolicy(sb, ws);
  const thresholds = buildThresholds(policy.routing);
  const themes = policy.drafter?.value_themes ?? [];
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const byDomain = new Map(ents.map((e) => [String(e.attributes?.domain ?? '').toLowerCase(), e]));
  async function active(id: string, pred: string): Promise<number> {
    const rows = ((await sb.from('facts').select('id, object_text, supersedes').eq('workspace_id', ws).eq('subject_entity', id).eq('predicate', pred)).data ?? []) as any[];
    const pointed = new Set(rows.map((r) => r.supersedes).filter(Boolean)); const cur = rows.find((r) => !pointed.has(r.id));
    return cur ? parseFloat(cur.object_text) : NaN;
  }

  for (const r of ROWS) {
    const acct = byDomain.get(r.domain); if (!acct) { console.log(`${r.domain}: no account`); continue; }
    // 1. account-level buying signal -> rescore account
    await callTool(sb, actor, 'assert_fact', { subject_entity: acct.id, predicate: 'buying_signal', object_text: r.signal, confidence: 0.9 });
    const aScore = await scoreAndAssert(sb, actor, acct.id);
    // 2. link founder contact + score
    const link = await linkContactByProspectId(sb, actor, { account_entity_id: acct.id, name: r.contact.name, role: r.contact.role, linkedin_url: (r.contact as any).linkedin_url, prospect_id: (r.contact as any).prospect_id });
    await scoreAndAssert(sb, actor, link.contact_entity_id);
    const best = await loadBestContactScore(sb, ws, acct.id);
    // 3. how would the agent route?
    const acctFacts = ((await sb.from('facts').select('predicate, object_text, supersedes').eq('workspace_id', ws).eq('subject_entity', acct.id).is('supersedes', null)).data ?? []) as any[];
    const substantive = acctFacts.filter((f) => !f.predicate.startsWith('score_') && !['icp_fit','icp_fit_breakdown','contact_score'].includes(f.predicate)).map((f) => ({ predicate: f.predicate, object_text: f.object_text }));
    const bd = { industry_match: await active(acct.id,'score_industry_match'), stage_match: await active(acct.id,'score_stage_match'), signal_strength: await active(acct.id,'score_signal_strength'), evidence_depth: await active(acct.id,'score_evidence_depth'), recency: await active(acct.id,'score_recency'), graph_proximity: await active(acct.id,'score_graph_proximity'), rrf_prefilter: 0 };
    const d = selectAction({ workspace_id: ws, entity_id: acct.id, breakdown: bd, icp_total: aScore?.icp_total ?? 0, best_contact_score: best, recent_draft_at: null, recent_research_at: null, recent_contacts_request_at: null, dropped_until: null, cooldown_until: null, facts: substantive, value_themes: themes, thresholds });
    const cScore = await active(link.contact_entity_id, 'contact_score');
    console.log(`${acct.name.padEnd(11)} acct=${(aScore?.icp_total ?? 0).toFixed(2)} (sig ${bd.signal_strength.toFixed(2)}, evid ${bd.evidence_depth.toFixed(2)}) | ${r.contact.name} contact=${cScore.toFixed(2)} | -> ${d.action}`);
  }
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
