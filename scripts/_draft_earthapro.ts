import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { callTool, buildDrafterDecision, renderAttributesProse, chatCompleteForWorkspace, getPolicy } from '@agent-crm/tools';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const w = ((await sb.from('workspaces').select('id, about, constitution').limit(50)).data ?? []).find((x:any)=>String(x.id).startsWith('af602fa1')) as any;
  const ws = w.id as string;
  const actor = { workspace_id: ws, actor_kind: 'agent' as const, actor_id: 'drafter' };
  const policy = await getPolicy(sb, ws);

  // resolve EarthaPro account + Courtney contact
  const ents: any[] = [];
  for (let from=0;;from+=1000){ const rows=((await sb.from('entities').select('id, name, attributes').eq('workspace_id', ws).range(from,from+999)).data??[]) as any[]; ents.push(...rows); if(rows.length<1000)break; }
  const acct = ents.find((e)=> String(e.attributes?.domain).toLowerCase()==='earthapro.com');
  const cidRow = (await sb.from('facts').select('subject_entity').eq('workspace_id', ws).eq('predicate','prospect_id').eq('object_text','2ff2798ec7c7524be6e7664bbc571f581e9bba4f').is('supersedes',null).maybeSingle()).data as any;
  const cid = cidRow?.subject_entity;
  // just-in-time: persist Courtney's email
  await callTool(sb, actor, 'assert_fact', { subject_entity: cid, predicate:'email', object_text:'courtneykrstich@earthapro.com', confidence:0.95 });

  // active facts on the account (with ids) for the drafter user message
  const af = ((await sb.from('facts').select('id, predicate, object_text, supersedes').eq('workspace_id', ws).eq('subject_entity', acct.id).is('supersedes', null)).data ?? []) as any[];
  const ADMIN = new Set(['icp_fit','icp_fit_breakdown','contact_score']);
  const factLines = af.filter((f)=> !f.predicate.startsWith('score_') && !ADMIN.has(f.predicate) && f.object_text).map((f)=>`  ${f.predicate}=${f.object_text} (${f.id})`).join('\n');

  const d = policy.drafter ?? {};
  const decision = buildDrafterDecision({ subject_style: d.subject_style, paragraph_count: d.paragraph_count, pain_points: d.pain_points, value_props: d.value_props, tone_keywords: d.tone_keywords, ask_examples: d.ask_examples, forbidden_field_terms: d.forbidden_field_terms, market_brief: d.market_brief });

  const system = `WORKSPACE CONSTITUTION (voice rules win over everything):\n${w.constitution ?? ''}\n\nWHAT WE SELL / ABOUT:\n${w.about ?? ''}\n\n${decision}`;
  const user = `ACCOUNT: ${acct.name}\n\nATTRIBUTES:\n${renderAttributesProse(acct.attributes)}\n\nACTIVE FACTS (predicate=value (fact_id)):\n${factLines}\n\nCONTACTS:\n  - Courtney Krstich <courtneykrstich@earthapro.com> — Co-founder (field-sales background)\n\nWrite the outbound email.`;

  const llm = await chatCompleteForWorkspace(sb, ws, { behavior:'drafter', model:'deepseek-v4-flash', max_tokens: 1600, response_format:{type:'json_object'}, messages:[{role:'system',content:system},{role:'user',content:user}] });
  let p:any; try { p = JSON.parse(llm.text); } catch { console.log('RAW:', llm.text); return; }
  console.log('=== DRAFT (agent -> Courtney Krstich, EarthaPro) ===');
  console.log('To:', p.to_email);
  console.log('Subject:', p.subject);
  console.log('\n' + (p.body ?? '').replace(/\\n/g,'\n'));
  console.log('\n--- reasoning:', p.reasoning);
  console.log('--- model:', llm.model, '| out_tokens:', llm.output_tokens);
}
main().catch((e)=>{ console.error('✗', e instanceof Error ? e.message : e); });
