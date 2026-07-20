import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { ensureScoringConfigState, entityIdsOfType, fetchAll, latestMarkerByEntity, ACTIVITY_MARKERS } from '@agent-crm/tools';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const { data: workspaces } = await sb.from('workspaces').select('id, name');
  for (const ws of workspaces ?? []) {
    const cfgChangedAt = await ensureScoringConfigState(sb, ws.id);
    const rows = await fetchAll<{ id: string; subject_entity: string; observed_at: string; supersedes: string | null }>(
      (from, to) => sb.from('facts')
        .select('id, subject_entity, observed_at, supersedes')
        .eq('workspace_id', ws.id).eq('predicate', 'icp_fit')
        .order('id', { ascending: true })
        .range(from, to),
    );
    const cfgMs = Date.parse(cfgChangedAt);
    const pointedTo = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
    const stale = rows.filter((r) => !pointedTo.has(r.id) && Date.parse(r.observed_at) < cfgMs);
    const scoredSet = new Set(rows.map((r) => r.subject_entity));
    const acctIds = (await entityIdsOfType(sb, ws.id, 'account')).slice(0, 10000);
    const unscored = acctIds.filter((id) => !scoredSet.has(id));
    const attempted = await latestMarkerByEntity(sb, ws.id, [...stale.map(r=>r.subject_entity), ...unscored].slice(0,2000), [ACTIVITY_MARKERS.RESCORE_NOOP]);
    const eligible = [...stale.map(r=>r.subject_entity), ...unscored].filter((id) => {
      const m = attempted.get(id); return m === undefined || m <= cfgMs;
    });
    console.log(`${ws.name} (${ws.id.slice(0,8)}): cfg_changed_at=${cfgChangedAt}  staleA=${stale.length}  unscoredB=${unscored.length}  eligible=${eligible.length}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
