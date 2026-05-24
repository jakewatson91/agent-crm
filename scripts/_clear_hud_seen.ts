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
  const r = await sb
    .from('entities')
    .select('id, name, attributes')
    .eq('workspace_id', WS)
    .ilike('name', 'hud')
    .limit(5);
  if (r.error) { console.error(r.error.message); process.exit(1); }
  if (!r.data?.length) { console.log('no HUD entity found'); process.exit(0); }
  for (const e of r.data) {
    const attrs = { ...((e.attributes as Record<string, any>) ?? {}) };
    const seenBefore = (attrs.ats_seen_jobs as string[] | undefined)?.length ?? 0;
    delete attrs.ats_seen_jobs;
    const upd = await sb.from('entities').update({ attributes: attrs }).eq('id', e.id);
    if (upd.error) console.error(`update failed for ${e.name}:`, upd.error.message);
    else console.log(`✓ ${e.name} (${e.id.slice(0, 8)}…) — cleared ats_seen_jobs (was ${seenBefore} ids)`);
  }
})();
