import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
async function main() {
  const since = new Date(Date.now() - 72 * 3600e3).toISOString();
  const byActor = new Map<string, { n: number; last: string }>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('events')
      .select('actor_id, created_at')
      .eq('action', 'assert_fact')
      .gte('created_at', since)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const cur = byActor.get(r.actor_id) ?? { n: 0, last: '' };
      cur.n++; if (r.created_at > cur.last) cur.last = r.created_at;
      byActor.set(r.actor_id, cur);
    }
    if ((data ?? []).length < PAGE) break;
  }
  console.log('assert_fact events last 72h by actor:');
  for (const [a, v] of [...byActor.entries()].sort((x, y) => y[1].n - x[1].n)) {
    console.log(`  ${a}: ${v.n}  (last ${v.last})`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
