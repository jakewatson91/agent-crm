import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = '7c4f79b1-518f-4e64-b634-f61aa14b88d2';
(async () => {
  for (const t of ['facts','signals','entities','channels','subscriptions','sources','conversations','events','workspace_members','gates','touches','channel_posts']) {
    try {
      const r = await sb.from(t).select('id', { count: 'exact', head: true }).eq('workspace_id', WS);
      console.log(t, r.count, r.error?.message ?? '');
    } catch (e) { console.log(t, 'ERR', e); }
  }
})();
