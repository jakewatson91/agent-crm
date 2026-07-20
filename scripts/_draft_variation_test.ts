import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { buildDrafterDecision, renderAttributesProse, chatCompleteForWorkspace, getPolicy } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const w = (await sb.from('workspaces').select('about, constitution').eq('id', ws).single()).data as any;
  const policy = await getPolicy(sb, ws);
  const d = policy.drafter ?? {};

  const accIds = ((await sb.from('facts').select('subject_entity').eq('workspace_id', ws).eq('predicate', 'is_a').eq('object_text', 'account').is('supersedes', null)).data ?? []).map((r: any) => r.subject_entity);
  const ents: any[] = [];
  for (let from = 0; ; from += 1000) { const rows = ((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from, from + 999)).data ?? []) as any[]; ents.push(...rows); if (rows.length < 1000) break; }
  const byId = new Map(ents.map((e) => [e.id, e]));

  const scored: Array<{ id: string; n: number }> = [];
  for (const id of accIds) {
    const { count } = await sb.from('facts').select('id', { count: 'exact', head: true }).eq('workspace_id', ws).eq('subject_entity', id).is('supersedes', null);
    if ((count ?? 0) >= 5) scored.push({ id, n: count ?? 0 });
  }
  scored.sort((a, b) => b.n - a.n);
  // spread across the ranked list for variety, not just the top
  const N = 5;
  const step = Math.max(1, Math.floor(scored.length / N));
  const picks = Array.from({ length: N }, (_, i) => scored[i * step]).filter(Boolean);

  const ADMIN = new Set(['icp_fit', 'icp_fit_breakdown', 'contact_score', 'score_total']);
  const decision = buildDrafterDecision({ subject_style: d.subject_style, paragraph_count: d.paragraph_count, pain_points: d.pain_points, value_props: d.value_props, tone_keywords: d.tone_keywords, ask_examples: d.ask_examples, forbidden_field_terms: d.forbidden_field_terms, market_brief: d.market_brief });

  for (const pk of picks) {
    const acct = byId.get(pk.id);
    if (!acct) continue;
    const af = ((await sb.from('facts').select('id, predicate, object_text').eq('workspace_id', ws).eq('subject_entity', pk.id).is('supersedes', null)).data ?? []) as any[];
    const factLines = af.filter((f) => !f.predicate.startsWith('score_') && !ADMIN.has(f.predicate) && f.object_text).map((f) => `  ${f.predicate}=${f.object_text} (${f.id})`).join('\n');
    const system = `WORKSPACE CONSTITUTION (voice rules win over everything):\n${w.constitution ?? ''}\n\nWHAT WE SELL / ABOUT:\n${w.about ?? ''}\n\n${decision}`;
    const user = `ACCOUNT: ${acct.name}\n\nATTRIBUTES:\n${renderAttributesProse(acct.attributes)}\n\nACTIVE FACTS (predicate=value (fact_id)):\n${factLines}\n\nWrite the outbound email.`;
    const llm = await chatCompleteForWorkspace(sb, ws, { behavior: 'drafter', model: 'deepseek-v4-flash', max_tokens: 1600, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] });
    console.log(`\n\n======================================================================`);
    console.log(`ACCOUNT: ${acct.name}   (${pk.n} active facts fed to the model)`);
    console.log(`MODEL: ${llm.model}  |  tokens in/out: ${llm.input_tokens}/${llm.output_tokens}  |  provider: ${llm.provider}`);
    console.log(`======================================================================`);
    let p: any; try { p = JSON.parse(llm.text); } catch { console.log('RAW (non-JSON):', llm.text.slice(0, 500)); continue; }
    if (p.action === 'request_gate' || p.action === 'skip') {
      console.log(`>> DRAFTER REFUSED (action=${p.action}). Reason: ${p.body || p.reason}`);
      continue;
    }
    console.log(`To: ${p.to_email}`);
    console.log(`Subject: ${p.subject}`);
    console.log('');
    console.log((p.body ?? '').replace(/\\n/g, '\n'));
    console.log(`\n[reasoning] ${p.reasoning}`);
    console.log(`[cites fact_ids] ${(p.cites ?? []).join(', ')}`);
  }
}
main().catch((e) => { console.error('✗', e instanceof Error ? e.message : e); });
