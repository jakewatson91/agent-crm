import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool, scoreAndAssert } from '@agent-crm/tools';

// Real, sourced signals pulled via Exa web search (manual collection phase).
const SIGNALS = [
  { pid: '70f5437fc214b6b1a9e2cd891c0522c3a98759b9', name: 'Spencer Mateega (AfterQuery)',
    text: 'AfterQuery raised a $30M Series A at a $300M valuation (Altos Ventures, Raine Group, YC). Surpassed $100M ARR in 12 months. Hiring across engineering, research, and operations. (BusinessWire + founder LinkedIn post, Apr 2026)',
    url: 'https://www.businesswire.com/news/home/20260409469482/en/' },
  { pid: 'abd627706ce53ac289283236c09b06966201758b', name: 'Marie Schneegans (14.ai)',
    text: '14.ai raised $3M seed (YC, General Catalyst, SV Angel). AI-native customer support agency replacing legacy support teams at startups; team of 6, plans to grow headcount in next 6 months; automating support, sales, and revenue-growth workflows. (TechCrunch, Mar 2026)',
    url: 'https://techcrunch.com/2026/03/02/a-married-founder-duos-company-14-ai-is-replacing-customer-support-teams-at-startups/' },
  { pid: '1d67b229e10e446b7a4ca4c52d2b22bec7a162bc', name: 'Cyril Gorlla (CTGT)',
    text: 'CTGT raised $7.2M seed led by Gradient (Google AI fund), General Catalyst, YC. Building a new AI stack that trains/deploys models 500x faster; expanding access to more enterprises; hiring. (Founder LinkedIn announcement, Feb 2025)',
    url: 'https://www.ctgt.ai/research/ctgt-raises-7-2m' },
];

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = ((await sb.from('workspaces').select('id')).data ?? []).find((w) => (w.id as string).startsWith('af602fa1'))!.id as string;
  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'source:exa:contact-signal' };
  async function active(id: string, pred: string): Promise<number> {
    const rows = ((await sb.from('facts').select('id, object_text, supersedes').eq('workspace_id', ws).eq('subject_entity', id).eq('predicate', pred)).data ?? []) as any[];
    const pointed = new Set(rows.map((r) => r.supersedes).filter(Boolean));
    const cur = rows.find((r) => !pointed.has(r.id));
    return cur ? parseFloat(cur.object_text) : NaN;
  }
  for (const s of SIGNALS) {
    const cid = ((await sb.from('facts').select('subject_entity').eq('workspace_id', ws).eq('predicate', 'prospect_id').eq('object_text', s.pid).is('supersedes', null).maybeSingle()).data as any)?.subject_entity;
    const sigB = await active(cid, 'score_signal_strength'); const totB = await active(cid, 'contact_score');
    await callTool(sb, actor, 'assert_fact', { subject_entity: cid, predicate: 'recent_funding', object_text: `${s.text} [source: ${s.url}]`, confidence: 0.95 });
    await scoreAndAssert(sb, actor, cid);
    const sigA = await active(cid, 'score_signal_strength'); const totA = await active(cid, 'contact_score');
    console.log(`${s.name.padEnd(28)} signal ${sigB.toFixed(2)} -> ${sigA.toFixed(2)} | contact_score ${totB.toFixed(2)} -> ${totA.toFixed(2)}`);
  }
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); process.exit(1); });
