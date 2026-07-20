// Size pool C: accounts whose latest substantive fact is newer than their
// current icp_fit fact. Also counts facts rows (to size the scan cost).
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { fetchAll, isSubstantiveFact } from '@agent-crm/tools';

async function main() {
  const sb = createServerClient();
  const { data: workspaces } = await sb.from('workspaces').select('id, name');
  for (const ws of workspaces ?? []) {
    const rows = await fetchAll<{ id: string; subject_entity: string; predicate: string; observed_at: string; supersedes: string | null }>(
      (from, to) => sb.from('facts')
        .select('id, subject_entity, predicate, observed_at, supersedes')
        .eq('workspace_id', ws.id)
        .order('id', { ascending: true })
        .range(from, to),
    );
    const pointedTo = new Set(rows.map((r) => r.supersedes).filter(Boolean));
    const scoreAt = new Map<string, number>();   // current icp_fit per entity
    const factAt = new Map<string, number>();    // latest substantive fact per entity
    for (const r of rows) {
      const ts = Date.parse(r.observed_at);
      if (r.predicate === 'icp_fit' && !pointedTo.has(r.id)) {
        if (ts > (scoreAt.get(r.subject_entity) ?? 0)) scoreAt.set(r.subject_entity, ts);
      } else if (isSubstantiveFact(r.predicate)) {
        if (ts > (factAt.get(r.subject_entity) ?? 0)) factAt.set(r.subject_entity, ts);
      }
    }
    let poolC = 0; let maxAgeDays = 0;
    for (const [ent, fts] of factAt) {
      const sts = scoreAt.get(ent);
      if (sts !== undefined && fts > sts) {
        poolC++;
        maxAgeDays = Math.max(maxAgeDays, (Date.now() - fts) / 86400_000);
      }
    }
    console.log(ws.name, '| facts rows:', rows.length, '| scored entities:', scoreAt.size, '| poolC (fact newer than score):', poolC, '| oldest such fact (days ago):', maxAgeDays.toFixed(1));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
