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
  const HUD_ID = 'e658445f-f866-46be-be02-b8a36a5497c5';

  // Show HUD's current attributes
  const e = await sb.from('entities').select('id, name, attributes').eq('id', HUD_ID).single();
  const attrs = (e.data?.attributes ?? {}) as Record<string, any>;
  console.log('HUD ats hint:', attrs.ats);
  console.log('HUD ats_seen_jobs length:', (attrs.ats_seen_jobs as string[] | undefined)?.length ?? 0);

  // Show ALL HUD hiring signals (any time) with their classifications
  const all = await sb
    .from('signals')
    .select('id, body_for_embedding, structured_tags, created_at')
    .eq('workspace_id', WS)
    .eq('entity_id', HUD_ID)
    .eq('type', 'hiring_post')
    .order('created_at', { ascending: false });
  console.log('\nALL HUD hiring signals:', all.data?.length);
  for (const s of all.data ?? []) {
    const t = (s.structured_tags ?? {}) as Record<string, any>;
    console.log(`  ${s.created_at}  ${t.role_family}/${t.role_seniority}${t.role_is_exec ? ' EXEC' : ''}  -  ${t.job_title}  [ext=${t.job_external_id}]`);
  }

  // Also, look at the 13 NEW signals created (any entity) in the last 10 min to see what passed
  const fresh = await sb
    .from('signals')
    .select('id, entity_id, structured_tags, created_at')
    .eq('workspace_id', WS)
    .eq('type', 'hiring_post')
    .gte('created_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });
  console.log('\n13 (or so) fresh signals from latest run:', fresh.data?.length);
  // Look up entity names
  const entIds = [...new Set((fresh.data ?? []).map((s) => s.entity_id as string))];
  const entMap = new Map<string, string>();
  if (entIds.length) {
    const er = await sb.from('entities').select('id, name').in('id', entIds);
    for (const r of er.data ?? []) entMap.set(r.id as string, r.name as string);
  }
  for (const s of fresh.data ?? []) {
    const t = (s.structured_tags ?? {}) as Record<string, any>;
    console.log(`  ${entMap.get(s.entity_id as string)}  -  ${t.role_family}/${t.role_seniority}${t.role_is_exec ? ' EXEC' : ''}  -  ${t.job_title}`);
  }
})();
