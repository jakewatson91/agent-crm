import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

(async () => {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  const r = await sb.from('workspaces').select('policy').eq('id', WS).single();
  if (r.error) { console.error(r.error.message); process.exit(1); }
  const p = ((r.data?.policy as Record<string, any>) ?? {});
  p.hiring_filter = {
    include_families: ['sales', 'gtm', 'revops', 'growth', 'founder'],
    include_seniorities: [],
    exclude_families: [],
    always_include_exec: true,
  };
  const upd = await sb.from('workspaces').update({ policy: p }).eq('id', WS);
  if (upd.error) { console.error('update failed:', upd.error.message); process.exit(1); }
  console.log('✓ set policy.hiring_filter:', JSON.stringify(p.hiring_filter));
})();
