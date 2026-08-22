import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main(){
  for (const t of ['entities','facts','signals','events','channels']) {
    const { data } = await sb.from(t).select('*').limit(1);
    console.log(t, '=>', Object.keys(data?.[0] ?? {}).join(', '));
  }
}
main();
