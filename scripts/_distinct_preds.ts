import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { ADMIN_PREDICATES } from '../packages/tools/src/scoring.ts';
async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
  // page through all active facts, tally predicates
  const counts = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data } = await sb.from('facts').select('predicate, supersedes, id')
      .eq('workspace_id', ws).range(from, from + PAGE - 1).order('id', { ascending: true });
    if (!data?.length) break;
    for (const r of data as any[]) counts.set(r.predicate, (counts.get(r.predicate) ?? 0) + 1);
    if (data.length < PAGE) break;
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  console.log('predicate                          count   counts-as-evidence?');
  for (const [p, c] of rows) {
    const isAdmin = ADMIN_PREDICATES.has(p) || p.startsWith('score_');
    console.log(`${p.padEnd(34)} ${String(c).padStart(6)}   ${isAdmin ? 'no (excluded)' : 'YES'}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
