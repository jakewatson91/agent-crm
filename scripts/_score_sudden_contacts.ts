/**
 * One-time: score Sudden's CSV-imported contacts so the advance pass can see
 * them. scoreAndAssert dispatches contact entities to scoreContact and writes
 * contact_score facts. Run AFTER the account backfill — a contact's account_fit
 * component reads its parent account's icp_fit.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert, entityIdsOfType } from '@agent-crm/tools';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'rescore_all_script' };
  const ids = await entityIdsOfType(sb, WS, 'contact');
  console.log(`scoring ${ids.length} contacts…`);
  let scored = 0, skipped = 0, failed = 0;
  for (const id of ids) {
    try {
      const r = await scoreAndAssert(sb, actor, id);
      if (r) { scored++; process.stdout.write('.'); } else { skipped++; process.stdout.write('-'); }
    } catch (e) {
      failed++;
      process.stdout.write('x');
      if (failed <= 3) console.error('\n', id, e instanceof Error ? e.message : e);
    }
  }
  console.log(`\n✓ scored ${scored}, skipped ${skipped}, failed ${failed}`);
  const { data } = await sb.from('facts').select('object_text').eq('workspace_id', WS).eq('predicate', 'contact_score');
  const vals = (data ?? []).map((r) => parseFloat(r.object_text as string)).filter(Number.isFinite).sort((a, b) => b - a);
  const above = vals.filter((v) => v >= 0.5).length;
  console.log(`contact_score distribution: n=${vals.length}, >=0.5: ${above}, top5: ${vals.slice(0, 5).map((v) => v.toFixed(2)).join(', ')}, bottom5: ${vals.slice(-5).map((v) => v.toFixed(2)).join(', ')}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
