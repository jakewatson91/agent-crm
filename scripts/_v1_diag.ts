import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function fetchAll(table: string, cols: string, apply: (q: any)=>any) {
  const PAGE=1000; let out:any[]=[];
  for(let from=0;;from+=PAGE){ const {data,error}=await apply(sb.from(table).select(cols)).range(from,from+PAGE-1);
    if(error) throw new Error(error.message); out.push(...(data??[]));
    if(!data||data.length<PAGE) break; }
  return out;
}

async function main(){
  const ws = (await sb.from('workspaces').select('id,name')).data ?? [];
  console.log('workspaces:', ws.map(w=>`${w.name}=${w.id.slice(0,8)}`).join(', '));
  const WS = ws[0]?.id;
  if(!WS){ console.log('no ws'); return; }

  // current score facts (not-superseded = not pointed-to)
  const scoreRows = await fetchAll('facts','id,subject_entity,predicate,object_text,supersedes',(q)=>q.eq('workspace_id',WS).in('predicate',['score_total','score_signal_strength','score_evidence_depth']));
  const pointed = new Set(scoreRows.map(r=>r.supersedes).filter(Boolean));
  const cur: Record<string,any> = {};
  for(const r of scoreRows){ if(pointed.has(r.id)) continue; const e=cur[r.subject_entity]??={};
    const v=parseFloat(r.object_text); if(r.predicate==='score_total')e.tot=v; if(r.predicate==='score_signal_strength')e.sig=v; if(r.predicate==='score_evidence_depth')e.ev=v; }
  const scored = Object.entries(cur);
  console.log('accounts with a current score:', scored.length);
  const gate = scored.filter(([_,e])=>e.tot>=0.65 && e.sig>=0.70 && e.ev>=0.50);
  console.log('clear all 3 draft gates:', gate.length);

  // contacts_requested / contacts_completed markers (events)
  const reqEv = await fetchAll('events','target_id,created_at',(q)=>q.eq('workspace_id',WS).eq('action','contacts_requested'));
  const compEv = await fetchAll('events','target_id,created_at',(q)=>q.eq('workspace_id',WS).eq('action','contacts_completed'));
  const requested = new Set(reqEv.map(r=>r.target_id));
  const completed = new Set(compEv.map(r=>r.target_id));
  console.log('accounts ever contacts_requested:', requested.size, '| ever contacts_completed:', completed.size);
  const gateIds = gate.map(([id])=>id);
  console.log('of the gate-clearing accounts:',
    '\n  requested:', gateIds.filter(id=>requested.has(id)).length,
    '\n  completed:', gateIds.filter(id=>completed.has(id)).length);

  // draft posts
  const drafts = await sb.from('channel_posts').select('id',{head:true,count:'exact'}).eq('kind','touch_draft');
  const gates = await sb.from('gates').select('id,status',{count:'exact'}).eq('workspace_id',WS);
  console.log('touch_draft posts (all ws):', drafts.count, '| gates rows:', gates.count, gates.data?.slice(0,3));

  // provider config
  const pol = (await sb.from('workspaces').select('policy').eq('id',WS).maybeSingle()).data?.policy as any;
  console.log('enrichment policy:', JSON.stringify(pol?.enrichment ?? null));
  console.log('env keys present: HUNTER=',!!process.env.HUNTER_API_KEY,'EXPLORIUM=',!!process.env.EXPLORIUM_API_KEY,'DEEPSEEK=',!!process.env.DEEPSEEK_API_KEY,'AI_GATEWAY=',!!process.env.AI_GATEWAY_API_KEY);
}
main().catch(e=>{console.error(e);process.exit(1);});
