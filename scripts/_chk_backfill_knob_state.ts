import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const { data } = await sb.from('workspaces').select('id, name, policy').order('created_at');
  for (const w of data ?? []) {
    const p = w.policy as any;
    console.log(w.name, w.id.slice(0,8), 'backfill_per_day=', p?.research?.domain_backfill_per_day, 'pipeline=', JSON.stringify(p?.pipeline ?? null)?.slice(0,140), 'max_contact_pulls=', p?.enrichment?.max_contact_pulls_per_run, 'contact_provider=', JSON.stringify(p?.enrichment?.contact_provider ?? p?.contact_provider ?? null));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
