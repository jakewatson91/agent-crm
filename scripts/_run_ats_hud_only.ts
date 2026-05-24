/**
 * HUD-only ATS connector smoke. Counts signals created on the HUD entity
 * AFTER applying the workspace's hiring_filter, so we can verify the filter
 * drops non-matching roles. Bypasses the rest of the watchlist for speed.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import ats from '../inngest/functions/sources/connectors/ats.js';

const WS = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const SOURCE_ID = '8f72e1dd-8679-415e-9ae6-63de6a1b39c0';
const HUD = 'hud';

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

(async () => {
  // Find HUD's entity id
  const ent = await sb.from('entities').select('id, name').eq('workspace_id', WS).ilike('name', HUD).maybeSingle();
  if (!ent.data) { console.error('HUD not found'); process.exit(1); }
  console.log('HUD entity:', ent.data.id);

  // Temporarily replace the watched_accounts CTE-equivalent by a min watchlist.
  // The connector calls getWatchedAccounts(supabase, workspace_id) — we can't
  // monkeypatch that. Instead we exploit max_entities_per_run=1 + the fact
  // that the connector orders entities so those with no/stale ATS hints come
  // first. After deletion above, HUD has hint cached so it won't be first.
  //
  // Simpler: just run the connector with max_entities_per_run=1 — it picks the
  // highest-priority entity which is now HUD (we cleared its seen_jobs but kept
  // the cached ATS hint, so it'll fetch fresh and diff against an empty set).
  // BUT it might pick a different entity if any others have stale hints.
  //
  // Safest: count signals before and after for HUD specifically.
  const before = await sb
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS)
    .eq('entity_id', ent.data.id)
    .eq('type', 'hiring_post');

  console.log('HUD hiring signals BEFORE rerun:', before.count);

  console.log('\nRunning ATS connector (max_entities_per_run=200, full sweep)...');
  const t0 = Date.now();
  const result = await ats({
    supabase: sb,
    workspace_id: WS,
    source_id: SOURCE_ID,
    config: { max_entities_per_run: 200 },
    last_run_at: null,
  } as any);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s. signals_created=${result.signals_created}, skipped=${result.skipped}`);

  const after = await sb
    .from('signals')
    .select('id, structured_tags, created_at')
    .eq('workspace_id', WS)
    .eq('entity_id', ent.data.id)
    .eq('type', 'hiring_post')
    .gte('created_at', new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false });

  console.log('\nNew HUD hiring signals (last 10 min):');
  for (const s of after.data ?? []) {
    const t = (s.structured_tags ?? {}) as Record<string, any>;
    console.log(`  ${t.role_family}/${t.role_seniority}${t.role_is_exec ? ' (exec)' : ''}  -  ${t.job_title}`);
  }
  console.log(`Count of new HUD hiring signals: ${after.data?.length ?? 0}`);
})();
