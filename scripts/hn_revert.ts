/**
 * Reverse the earlier HN reactivation. The HN connector is hard-coded to
 * watch-only mode; the 3 configured sources have keyword-based intent and
 * empty watch_entities, so they'd error every hour ("watch_entities is
 * empty"). Better to leave them off until either:
 *   - watch_entities is configured per source, OR
 *   - the HN connector grows a discover mode (matches keywords + LLM
 *     extracts company per hit).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const r = await sb.from('sources')
    .update({ active: false })
    .eq('connector_type', 'hn')
    .eq('active', true)
    .select('name');
  console.log(`HN: deactivated ${r.data?.length ?? 0} source(s) pending discover-mode fix`);
  for (const row of r.data ?? []) console.log(`  ${(row as any).name}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
