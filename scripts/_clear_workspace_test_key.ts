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
  const p = ((r.data?.policy as Record<string, any>) ?? {});
  const env = ((p.env as Record<string, string>) ?? {});
  const v = env.OPENAI_API_KEY ?? '';
  if (v.includes('sk-test') || v.length === 0) {
    delete env.OPENAI_API_KEY;
    p.env = env;
    const upd = await sb.from('workspaces').update({ policy: p }).eq('id', WS);
    if (upd.error) { console.error('update failed:', upd.error.message); process.exit(1); }
    console.log(`✓ cleared policy.env.OPENAI_API_KEY (was placeholder, ${v.length} chars). Process.env will now win.`);
  } else {
    console.log(`policy.env.OPENAI_API_KEY does not look like a placeholder (length=${v.length}); leaving untouched.`);
  }
})();
