import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';

// paginate any select to beat the 1000-row PostgREST cap
async function pageAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = []; const step = 1000; let from = 0;
  for (;;) {
    const { data, error } = await build(from, from + step - 1);
    if (error) throw error;
    out.push(...(data as T[]));
    if (!data || data.length < step) break;
    from += step;
  }
  return out;
}

async function main() {
  // all channels in ws
  const chans = await pageAll<{id:string; title:string}>((f,t)=>
    sb.from('channels').select('id, title').eq('workspace_id', WS).range(f,t));
  const chanIds = chans.map(c=>c.id);
  console.log(`channels: ${chanIds.length}`);

  // all claim posts in ws (via channel ids — batch the .in())
  let claims: any[] = [];
  for (let i=0;i<chanIds.length;i+=200){
    const batch = chanIds.slice(i,i+200);
    const part = await pageAll<any>((f,t)=>
      sb.from('channel_posts').select('id, channel_id, cites, created_at, body')
        .in('channel_id', batch).eq('kind','claim').range(f,t));
    claims.push(...part);
  }
  console.log(`total claim posts: ${claims.length}`);

  // group per channel; a channel's claims are "duplicate-heavy" if many share cited signals
  const byChan = new Map<string, any[]>();
  for (const c of claims){ (byChan.get(c.channel_id) ?? byChan.set(c.channel_id,[]).get(c.channel_id))!.push(c); }

  // dedup rule candidate: within a channel, two claims are dupes if their cite-sets overlap (share >=1 signal id) OR both empty.
  // Build clusters via union-find on shared cites; count deletable = clusterSize-1 (keep newest per cluster).
  let totalDeletable = 0; const heavy: {title:string; claims:number; deletable:number}[] = [];
  const titleByChan = new Map(chans.map(c=>[c.id,c.title]));
  for (const [chId, cl] of byChan){
    // union-find
    const parent = new Map<number,number>(); cl.forEach((_,i)=>parent.set(i,i));
    const find=(x:number):number=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x)!)!); x=parent.get(x)!;} return x; };
    const uni=(a:number,b:number)=>{ parent.set(find(a),find(b)); };
    const sigToIdx = new Map<string, number>();
    cl.forEach((p,i)=>{
      const cites: string[] = Array.isArray(p.cites)?p.cites:[];
      const key = cites.length? cites : ['__empty__'];
      for (const s of key){ if(sigToIdx.has(s)) uni(i, sigToIdx.get(s)!); else sigToIdx.set(s,i); }
    });
    const clusters = new Map<number, number[]>();
    cl.forEach((_,i)=>{ const r=find(i); (clusters.get(r)??clusters.set(r,[]).get(r))!.push(i); });
    let del=0; for (const idxs of clusters.values()) if(idxs.length>1) del += idxs.length-1;
    totalDeletable += del;
    if (del>0) heavy.push({ title: titleByChan.get(chId)||chId.slice(0,8), claims: cl.length, deletable: del });
  }
  heavy.sort((a,b)=>b.deletable-a.deletable);
  console.log(`\nchannels with deletable dup claims: ${heavy.length}`);
  console.log(`TOTAL deletable claim posts (keep newest per cluster): ${totalDeletable}`);
  console.log(`\ntop 25 channels:`);
  for (const h of heavy.slice(0,25)) console.log(`  ${String(h.deletable).padStart(4)} del / ${String(h.claims).padStart(4)} claims  ${h.title}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
