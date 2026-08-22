import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function fetchAll(table: string, sel: string, mod: (q:any)=>any = q=>q) {
  let out: any[] = []; let from = 0;
  for(;;){ const { data, error } = await mod(sb.from(table).select(sel)).range(from, from+999);
    if (error) { console.error(table, error.message); break; }
    out = out.concat(data ?? []); if (!data || data.length < 1000) break; from += 1000; }
  return out;
}
function lev(a: string, b: string) { // normalized similarity, cheap
  const A=a.split(/\s+/), B=b.split(/\s+/);
  const setB = new Set(B); let hit=0; for(const w of A) if(setB.has(w)) hit++;
  return hit / Math.max(A.length, B.length, 1);
}
async function main() {
  const gates = await fetchAll('gates','id,policy,requested_at,decision,decided_at,resolution',(q:any)=>q.eq('policy','outreach_send').order('requested_at',{ascending:false}));
  console.log('outreach_send gates:', gates.length);
  const dec = gates.filter(g=>g.decision);
  console.log('decided:', dec.length, 'approve', dec.filter(g=>g.decision==='approve').length, 'reject', dec.filter(g=>g.decision==='reject').length);
  console.log('\n=== APPROVALS, newest first ===');
  for (const g of gates.filter(g=>g.decision==='approve')) {
    const r = g.resolution ?? {};
    const d = (r.body_diff ?? [])[0];
    const sim = d ? lev(d.from ?? '', d.to ?? '') : null;
    console.log(`\n[${g.requested_at.slice(0,10)}] edited=${!!r.edited} wordOverlap=${sim!==null?(sim*100).toFixed(0)+'%':'n/a'} note=${r.note ?? ''}`);
    if (d) { console.log('  FROM:', (d.from??'').replace(/\n/g,' ').slice(0,400)); console.log('  TO  :', (d.to??'').replace(/\n/g,' ').slice(0,400)); }
  }
  console.log('\n=== REJECTIONS with notes ===');
  for (const g of gates.filter(g=>g.decision==='reject')) {
    const r = g.resolution ?? {};
    if (r.note) console.log(`[${g.requested_at.slice(0,10)}] ${r.note}`);
  }
}
main();
