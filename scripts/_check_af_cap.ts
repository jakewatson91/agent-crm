import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
(async () => {
  const r = await sb.from('workspaces').select('policy').eq('id', 'af602fa1-1e0b-4bee-9841-01894553e0a9').maybeSingle();
  const p = r.data?.policy as any;
  console.log('max_contact_pulls_per_run:', p?.enrichment?.max_contact_pulls_per_run);
  console.log('max_drafts_per_run:', p?.enrichment?.max_drafts_per_run);
  console.log('contact_provider:', p?.enrichment?.contact_provider);
})();
