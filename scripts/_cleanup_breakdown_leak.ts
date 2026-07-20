import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const EXECUTE = process.argv.includes('--execute');

async function pageAll<T>(b:(f:number,t:number)=>any):Promise<T[]>{const o:T[]=[];let f=0;for(;;){const{data,error}=await b(f,f+999);if(error)throw error;o.push(...(data as T[]));if(!data||data.length<1000)break;f+=1000;}return o;}

async function main(){
  // every icp_fit_breakdown fact in the workspace
  const rows = await pageAll<any>((f,t)=>sb.from('facts')
    .select('id, subject_entity, supersedes, observed_at, created_at')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit_breakdown').range(f,t));
  console.log(`total icp_fit_breakdown rows: ${rows.length}`);

  // rows pointed-to by another row's supersedes — never delete these (would orphan a chain)
  const pointedTo = new Set(rows.map(r=>r.supersedes).filter(Boolean));

  // per entity: keep the newest (observed_at, then created_at); delete the older orphans
  const byEnt = new Map<string, any[]>();
  for (const r of rows){ (byEnt.get(r.subject_entity)??byEnt.set(r.subject_entity,[]).get(r.subject_entity))!.push(r); }
  const ts = (r:any)=>Date.parse(r.observed_at ?? r.created_at) || 0;
  const toDelete:string[]=[];
  for (const [, ents] of byEnt){
    ents.sort((a,b)=>ts(b)-ts(a)); // newest first
    const keep = ents[0].id;
    for (const r of ents){ if (r.id!==keep && !pointedTo.has(r.id)) toDelete.push(r.id); }
  }
  console.log(`entities with a breakdown: ${byEnt.size}`);
  console.log(`keep (newest per entity): ${byEnt.size}`);
  console.log(`delete (stale older orphans): ${toDelete.length}`);

  // safety: are any to-delete ids cited by a channel_post? (breakdown facts are never posted, so expect 0)
  let cited = 0;
  const delSet = new Set(toDelete);
  const posts = await pageAll<any>((f,t)=>sb.from('channel_posts').select('cites').eq('kind','claim').not('cites','is',null).range(f,t)).catch(()=>[] as any[]);
  for (const p of posts){ for (const c of (Array.isArray(p.cites)?p.cites:[])) if (delSet.has(c)) cited++; }
  console.log(`to-delete ids referenced in any claim's cites: ${cited} (expect 0)`);

  if (!EXECUTE){ console.log('\n[dry-run] pass --execute to delete'); return; }
  if (cited>0){ console.error('ABORT: some target facts are cited by posts; not deleting.'); process.exit(1); }

  let deleted=0;
  for (let i=0;i<toDelete.length;i+=200){
    const batch=toDelete.slice(i,i+200);
    const {error}=await sb.from('facts').delete().in('id',batch);
    if (error) throw error;
    deleted+=batch.length;
  }
  console.log(`\nDONE. deleted ${deleted} stale breakdown facts.`);
  const after = await sb.from('facts').select('id',{count:'exact',head:true}).eq('workspace_id',WS).eq('predicate','icp_fit_breakdown');
  console.log(`remaining icp_fit_breakdown rows: ${after.count} (should equal entities: ${byEnt.size})`);
}
main().catch(e=>{console.error(e);process.exit(1);});
