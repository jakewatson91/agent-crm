import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS='e7052848-2270-41ac-90b6-d9b75c87f6d3';
async function main(){
  const { data: w } = await sb.from('workspaces').select('name,about,constitution,persona,icp,policy').eq('id',WS).single();
  const p:any = w!.policy;
  console.log('ABOUT len', (w!.about??'').length);
  console.log('CONSTITUTION len', (w!.constitution??'').length);
  console.log('PERSONA len', JSON.stringify(w!.persona??'').length);
  console.log('ICP len', JSON.stringify(w!.icp??'').length);
  console.log('\nPOLICY top-level keys:', Object.keys(p));
  const count = (o:any, path=''): number => {
    if (o===null||typeof o!=='object') return 1;
    if (Array.isArray(o)) return o.length ? o.reduce((s,v)=>s+count(v),0) : 1;
    return Object.entries(o).reduce((s,[k,v])=>s+count(v, path+'.'+k), 0);
  };
  for (const k of Object.keys(p)) console.log('  ', k.padEnd(22), 'leaves:', count(p[k]));
  console.log('\nDRAFTER policy:');
  console.log(JSON.stringify(p.drafter, null, 1).slice(0, 6000));
}
main();
