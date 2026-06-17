/**
 * Is the entity-research-dispatcher actually researching?
 *
 *   pnpm research:check                 # default workspace (af602fa1)
 *   WORKSPACE_ID=<uuid> pnpm research:check
 *
 * Prints: research_result signal count + the most recent ones (entity, url,
 * when), plus research_triggered / research_completed marker counts. If the
 * counts climb between runs after a deploy, the dispatcher is alive.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const ws = process.env.WORKSPACE_ID ?? 'af602fa1-1e0b-4bee-9841-01894553e0a9';

(async () => {
  console.log(`workspace: ${ws}\n`);

  for (const pred of ['research_triggered', 'research_completed']) {
    const { count } = await db
      .from('facts')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', ws)
      .eq('predicate', pred);
    const { data: last } = await db
      .from('facts')
      .select('observed_at')
      .eq('workspace_id', ws)
      .eq('predicate', pred)
      .order('observed_at', { ascending: false })
      .limit(1);
    const ago = last?.[0]
      ? `${((Date.now() - Date.parse(last[0].observed_at as string)) / 3600000).toFixed(1)}h ago`
      : 'never';
    console.log(`${pred}: ${count ?? 0}   (last: ${ago})`);
  }

  const { count: rrCount } = await db
    .from('signals')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', ws)
    .eq('type', 'research_result');
  console.log(`research_result signals: ${rrCount ?? 0}\n`);

  const { data: recent } = await db
    .from('signals')
    .select('entity_id, observed_at, created_at, structured_tags')
    .eq('workspace_id', ws)
    .eq('type', 'research_result')
    .order('created_at', { ascending: false })
    .limit(10);

  if (!recent?.length) {
    console.log('no research_result signals yet.');
    return;
  }

  const eids = [...new Set(recent.map((r) => r.entity_id as string))];
  const { data: ents } = await db.from('entities').select('id, name').in('id', eids);
  const nm = new Map((ents ?? []).map((e: { id: string; name: string }) => [e.id, e.name]));

  console.log('=== 10 most recent research_result signals ===');
  for (const r of recent) {
    const tags = r.structured_tags as { url?: string; triggered_by?: string } | null;
    const when = ((Date.now() - Date.parse(r.created_at as string)) / 3600000).toFixed(1);
    console.log(`  ${when}h ago  ${nm.get(r.entity_id as string) ?? r.entity_id}`);
    console.log(`     ${tags?.url ?? '(no url)'}   [${tags?.triggered_by ?? '?'}]`);
  }
})();
