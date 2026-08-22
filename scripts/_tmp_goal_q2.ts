import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const { data: chans } = await sb.from('channels').select('id,entity_id,kind').eq('workspace_id', WS).limit(5000);
  const chanMap = new Map((chans ?? []).map((c: any) => [c.id, c]));
  const ids = (chans ?? []).map((c: any) => c.id);
  // drafts
  let all: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('channel_posts').select('id,channel_id,kind,body,created_at,argument_id,withdrawn_at,withdrawn_reason')
      .in('channel_id', ids.slice(i, i+200)).eq('kind','touch_draft').order('created_at',{ascending:false});
    all = all.concat(data ?? []);
  }
  all.sort((a,b)=> b.created_at.localeCompare(a.created_at));
  console.log('TOTAL touch_drafts (Sudden):', all.length);
  const withdrawn = all.filter(d=>d.withdrawn_at);
  console.log('withdrawn:', withdrawn.length, ' with argument_id:', all.filter(d=>d.argument_id).length);
  const byMonth: Record<string, {n:number, w:number}> = {};
  for (const d of all) { const m = d.created_at.slice(0,7); byMonth[m] ??= {n:0,w:0}; byMonth[m].n++; if (d.withdrawn_at) byMonth[m].w++; }
  console.log('by month:', byMonth);
  console.log('\n=== LAST 12 DRAFTS ===');
  for (const d of all.slice(0,12)) {
    const ch: any = chanMap.get(d.channel_id);
    const { data: ent } = await sb.from('entities').select('name').eq('id', ch?.entity_id).maybeSingle();
    console.log(`\n--- ${d.created_at} | ${ent?.name ?? '?'} | arg=${d.argument_id ? 'YES':'no'} | ${d.withdrawn_at ? 'WITHDRAWN: '+d.withdrawn_reason : 'live'}`);
    console.log(d.body);
  }
}
main();
