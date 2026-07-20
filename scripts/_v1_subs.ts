import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  const ws = ((await sb.from('workspaces').select('id')).data??[]).find(w=>(w.id as string).startsWith('af602fa1'))!.id;
  const subs = (await sb.from('subscriptions').select('id, name, owner_kind, owner_id, agent_behavior, active').eq('workspace_id',ws)).data ?? [];
  console.log('SUBSCRIPTIONS:');
  for(const s of subs) console.log(`  ${(s.agent_behavior??'claim_poster').padEnd(12)} active=${s.active} owner=${s.owner_kind}:${String(s.owner_id).slice(0,8)} name="${s.name}" id=${String(s.id).slice(0,8)}`);
  const agents = (await sb.from('agents').select('id, name, kind').eq('workspace_id',ws)).data ?? [];
  console.log('AGENTS:');
  for(const a of agents) console.log(`  ${String(a.id).slice(0,8)} kind=${a.kind} name="${a.name}"`);
  // one qualified account with a contact, for a live drafter test
  console.log('\nQUALIFIED ACCOUNTS w/ current score>=.65:');
  const fr = [];
  for(let f=0;;f+=1000){ const {data}= await sb.from('facts').select('id,subject_entity,predicate,object_text,supersedes').eq('workspace_id',ws).in('predicate',['score_total','score_signal_strength','score_evidence_depth']).range(f,f+999); fr.push(...(data??[])); if(!data||data.length<1000)break; }
  const pointed=new Set(fr.map(r=>r.supersedes).filter(Boolean)); const cur:Record<string,any>={};
  for(const r of fr){ if(pointed.has(r.id))continue; const e=cur[r.subject_entity]??={}; const v=parseFloat(r.object_text); if(r.predicate==='score_total')e.tot=v; if(r.predicate==='score_signal_strength')e.sig=v; if(r.predicate==='score_evidence_depth')e.ev=v; e.anyFact=r.id; }
  const gate=Object.entries(cur).filter(([_,e]:any)=>e.tot>=0.65&&e.sig>=0.70&&e.ev>=0.50).sort((a:any,b:any)=>b[1].tot-a[1].tot);
  const top5 = gate.slice(0,5);
  for(const [id,e] of top5 as any){ const ent=(await sb.from('entities').select('name,attributes').eq('id',id).maybeSingle()).data; console.log(`  ${String(id).slice(0,8)} tot=${e.tot.toFixed(2)} sig=${e.sig.toFixed(2)} ev=${e.ev.toFixed(2)} name="${ent?.name}" domain=${(ent?.attributes as any)?.domain}`); }
  console.log('total qualified:', gate.length);
}
main().catch(e=>{console.error(e);process.exit(1);});
