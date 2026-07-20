import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
(async () => {
  const r = await sb.from('workspaces').select('policy').eq('id', WS).maybeSingle();
  const policy = (r.data?.policy ?? {}) as Record<string, any>;
  const next = {
    ...policy,
    enrichment: {
      ...(policy.enrichment ?? {}),
      contact_provider: 'hunter',
      hunter_monthly_cap: 15,
      max_contact_pulls_per_run: 3,
    },
  };
  const upd = await sb.from('workspaces').update({ policy: next }).eq('id', WS);
  if (upd.error) throw upd.error;
  console.log('contact_provider=hunter, hunter_monthly_cap=15, max_contact_pulls_per_run=3');
})();
