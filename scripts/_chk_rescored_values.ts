// Did the 14 Sudden pool-C rescores move scores? Compare current icp_fit vs
// the one it superseded for recently-rescored entities.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';

const SUDDEN = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createServerClient();
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const { data: fresh } = await sb.from('facts')
    .select('subject_entity, object_text, supersedes, observed_at')
    .eq('workspace_id', SUDDEN).eq('predicate', 'icp_fit')
    .gte('observed_at', cutoff);
  for (const f of (fresh ?? []) as any[]) {
    let prev: number | null = null;
    if (f.supersedes) {
      const { data: p } = await sb.from('facts').select('object_text').eq('id', f.supersedes).single();
      prev = (p as any)?.object_text ?? null;
    }
    console.log(f.subject_entity.slice(0, 8), 'prev=', prev, '→ new=', f.object_text);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
