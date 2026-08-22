import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const { data: ws } = await sb.from('workspaces').select('id,name,created_at').order('created_at');
  console.log('WORKSPACES');
  for (const w of ws ?? []) console.log(' ', w.id.slice(0,8), w.name, w.created_at);

  // channel_posts kinds
  const { data: kinds } = await sb.from('channel_posts').select('kind').limit(5000);
  const c: Record<string,number> = {};
  for (const k of kinds ?? []) c[k.kind] = (c[k.kind] ?? 0) + 1;
  console.log('\nCHANNEL_POST KINDS (last 5000)', c);

  // one sample row to see the shape
  const { data: sample } = await sb.from('channel_posts').select('*').eq('kind','touch_draft').order('created_at',{ascending:false}).limit(1);
  console.log('\nSAMPLE touch_draft keys:', Object.keys(sample?.[0] ?? {}));
  console.log(JSON.stringify(sample?.[0], null, 2).slice(0, 3000));
}
main();
