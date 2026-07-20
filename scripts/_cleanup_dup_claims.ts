import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const EXECUTE = process.argv.includes('--execute');

async function pageAll<T>(build:(f:number,t:number)=>any):Promise<T[]>{
  const out:T[]=[]; const step=1000; let f=0;
  for(;;){ const {data,error}=await build(f,f+step-1); if(error)throw error; out.push(...(data as T[])); if(!data||data.length<step)break; f+=step; }
  return out;
}

async function main(){
  const chans = await pageAll<{id:string}>((f,t)=>sb.from('channels').select('id').eq('workspace_id',WS).range(f,t));
  const chanIds = chans.map(c=>c.id);

  let claims:any[]=[];
  for(let i=0;i<chanIds.length;i+=200){
    const batch=chanIds.slice(i,i+200);
    const part=await pageAll<any>((f,t)=>sb.from('channel_posts').select('id, channel_id, cites, created_at').in('channel_id',batch).eq('kind','claim').range(f,t));
    claims.push(...part);
  }

  // cluster per channel by shared cites; mark all but newest for deletion
  const byChan=new Map<string,any[]>();
  for(const c of claims){ (byChan.get(c.channel_id)??byChan.set(c.channel_id,[]).get(c.channel_id))!.push(c); }
  const toDelete:string[]=[];
  for(const cl of byChan.values()){
    const parent=new Map<number,number>(); cl.forEach((_,i)=>parent.set(i,i));
    const find=(x:number):number=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x)!)!); x=parent.get(x)!;} return x; };
    const uni=(a:number,b:number)=>{ parent.set(find(a),find(b)); };
    const sigToIdx=new Map<string,number>();
    cl.forEach((p,i)=>{ const cites:string[]=Array.isArray(p.cites)?p.cites:[]; const key=cites.length?cites:['__empty__'];
      for(const s of key){ if(sigToIdx.has(s)) uni(i,sigToIdx.get(s)!); else sigToIdx.set(s,i); } });
    const clusters=new Map<number,number[]>();
    cl.forEach((_,i)=>{ const r=find(i); (clusters.get(r)??clusters.set(r,[]).get(r))!.push(i); });
    for(const idxs of clusters.values()){
      if(idxs.length<2) continue;
      idxs.sort((a,b)=>Date.parse(cl[b].created_at)-Date.parse(cl[a].created_at)); // newest first
      for(const i of idxs.slice(1)) toDelete.push(cl[i].id); // delete all but newest
    }
  }
  console.log(`claim posts marked for deletion: ${toDelete.length}`);

  // BFS to collect all descendants (decision children etc.) of the target claims
  const allTargets=new Set<string>(toDelete);
  let frontier=[...toDelete];
  while(frontier.length){
    const kids:any[]=[];
    for(let i=0;i<frontier.length;i+=200){
      const batch=frontier.slice(i,i+200);
      const part=await pageAll<any>((f,t)=>sb.from('channel_posts').select('id').in('parent_post_id',batch).range(f,t));
      kids.push(...part);
    }
    frontier=kids.map(k=>k.id).filter(id=>!allTargets.has(id));
    frontier.forEach(id=>allTargets.add(id));
  }
  const all=[...allTargets];
  console.log(`total posts to delete (claims + descendants): ${all.length}`);

  if(!EXECUTE){ console.log('\n[dry-run] pass --execute to delete'); return; }

  // delete leaves-first: repeatedly delete posts that are not a parent of any remaining target
  let remaining=new Set(all);
  let round=0, deleted=0;
  while(remaining.size){
    round++;
    const ids=[...remaining];
    // find which remaining ids are still referenced as a parent by another remaining id
    const referenced=new Set<string>();
    for(let i=0;i<ids.length;i+=200){
      const batch=ids.slice(i,i+200);
      const part=await pageAll<any>((f,t)=>sb.from('channel_posts').select('parent_post_id').in('id',batch).range(f,t));
      for(const r of part) if(r.parent_post_id && remaining.has(r.parent_post_id)) referenced.add(r.parent_post_id);
    }
    const leaves=ids.filter(id=>!referenced.has(id));
    if(!leaves.length){ console.error('cycle? aborting',remaining.size); break; }
    for(let i=0;i<leaves.length;i+=200){
      const batch=leaves.slice(i,i+200);
      const {error}=await sb.from('channel_posts').delete().in('id',batch);
      if(error)throw error;
      deleted+=batch.length;
    }
    leaves.forEach(id=>remaining.delete(id));
    console.log(`  round ${round}: deleted ${leaves.length} (cum ${deleted}), remaining ${remaining.size}`);
  }
  console.log(`\nDONE. deleted ${deleted} posts.`);
}
main().catch(e=>{console.error(e);process.exit(1);});
