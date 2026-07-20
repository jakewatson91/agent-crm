import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const WINDOW_MIN = 60;

// Simulate the coalescing guard over the last 24h of signals: for each signal,
// would a prior same-(entity,type) signal exist within WINDOW_MIN before it?
// If yes -> the new guard SKIPS this enrich. Count enrich runs saved.
async function main() {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { data: sigs } = await sb.from('signals')
    .select('id, entity_id, type, observed_at')
    .eq('workspace_id', ws).gte('observed_at', since)
    .order('observed_at', { ascending: true }).limit(2000);
  const rows = (sigs ?? []) as Array<{ id: string; entity_id: string; type: string; observed_at: string }>;

  // group by entity+type, sorted by time; a signal skips if the previous one in
  // its group is within WINDOW_MIN.
  const lastSeen = new Map<string, number>();
  let total = 0, wouldSkip = 0, wouldRun = 0;
  for (const s of rows) {
    if (!s.entity_id || !s.type) continue;
    total += 1;
    const key = `${s.entity_id}|${s.type}`;
    const t = Date.parse(s.observed_at);
    const prev = lastSeen.get(key);
    if (prev !== undefined && t - prev <= WINDOW_MIN * 60_000) wouldSkip += 1;
    else wouldRun += 1;
    lastSeen.set(key, t);
  }
  console.log(`signals_24h analyzed = ${total}`);
  console.log(`would RUN  enrich    = ${wouldRun}`);
  console.log(`would SKIP (coalesce)= ${wouldSkip}  (${(100 * wouldSkip / Math.max(1, total)).toFixed(0)}% of enrich runs eliminated)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
