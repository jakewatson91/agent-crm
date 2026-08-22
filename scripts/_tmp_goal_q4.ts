import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { data: all } = await sb.from('channel_posts').select('id,channel_id,body,created_at,withdrawn_at,withdrawn_reason,argument_id').eq('kind','touch_draft').order('created_at',{ascending:false}).limit(200);
  const byMonth: Record<string,{n:number,w:number}> = {};
  for (const d of all ?? []) { const m=d.created_at.slice(0,7); byMonth[m]??={n:0,w:0}; byMonth[m].n++; if(d.withdrawn_at) byMonth[m].w++; }
  console.log('DRAFTS BY MONTH', byMonth);
  const reasons: Record<string,number> = {};
  for (const d of all ?? []) if (d.withdrawn_reason) reasons[d.withdrawn_reason.slice(0,90)] = (reasons[d.withdrawn_reason.slice(0,90)]??0)+1;
  console.log('\nWITHDRAWAL REASONS', reasons);

  // gates = approvals
  const { data: gates } = await sb.from('gates').select('*').order('created_at',{ascending:false}).limit(300);
  console.log('\nGATES total', gates?.length, 'keys', Object.keys(gates?.[0]??{}));
  const gs: Record<string,number> = {};
  for (const g of gates ?? []) gs[`${g.status}`] = (gs[`${g.status}`]??0)+1;
  console.log('gate status', gs);
  const gm: Record<string,number> = {};
  for (const g of gates ?? []) gm[g.created_at.slice(0,7)] = (gm[g.created_at.slice(0,7)]??0)+1;
  console.log('gates by month', gm);
  console.log('\nsample gate', JSON.stringify(gates?.[0],null,2).slice(0,1200));
}
main();
