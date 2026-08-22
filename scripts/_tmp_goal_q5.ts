import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const g = await sb.from('gates').select('*').limit(3);
  console.log('gates err', g.error?.message, 'rows', g.data?.length, Object.keys(g.data?.[0]??{}));
  // event action distribution over 60d
  const since = new Date(Date.now()-60*864e5).toISOString();
  const { data: ev } = await sb.from('events').select('action,created_at').gte('created_at', since).limit(20000);
  const c: Record<string,number> = {};
  for (const e of ev ?? []) c[e.action]=(c[e.action]??0)+1;
  const sorted = Object.entries(c).sort((a,b)=>b[1]-a[1]);
  console.log('\nEVENTS last 60d, total', ev?.length);
  for (const [k,v] of sorted) console.log('  ', v.toString().padStart(6), k);
}
main();
