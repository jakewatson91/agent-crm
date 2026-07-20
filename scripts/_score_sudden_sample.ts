/**
 * One-off: score a sample of Sudden's accounts right after import instead of
 * waiting on the shared 50-per-30-min rescoreOnIcpChange cron (which would
 * take about a day to cover all ~2,158 accounts, competing with af602fa1 for
 * the same global budget). Sample = every account that got a real contact
 * during import (a valid email) — these are also the only accounts that could
 * actually produce a draft, which is the real proof-of-platform check.
 *
 * Workspace-parameterized variant of scripts/rescore_all.ts (which hardcodes
 * the dogfood workspace by name match).
 *
 * Usage: tsx scripts/_score_sudden_sample.ts <workspace_id>
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

async function main() {
  const WS = process.argv[2];
  if (!WS) { console.error('usage: tsx scripts/_score_sudden_sample.ts <workspace_id>'); process.exit(1); }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'score_sudden_sample_script' };

  // Accounts with a contact linked via works_at — these are the ones a draft
  // could actually reach, and the imported CSV only produced ~113 of them.
  const worksAt = await sb.from('facts').select('object_entity')
    .eq('workspace_id', WS).eq('predicate', 'works_at').is('supersedes', null);
  const acctIds = [...new Set(((worksAt.data ?? []) as Array<{ object_entity: string | null }>)
    .map((r) => r.object_entity).filter((x): x is string => !!x))];

  const names = await sb.from('entities').select('id, name').in('id', acctIds);
  const nameById = new Map(((names.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));

  const THROTTLE_MS = process.env.THROTTLE_MS ? Number(process.env.THROTTLE_MS) : 1000;
  console.log(`scoring ${acctIds.length} accounts with a real contact (throttle ${THROTTLE_MS}ms)…`);

  let done = 0, scored = 0;
  for (const id of acctIds) {
    const name = nameById.get(id) ?? id.slice(0, 8);
    try {
      const r = await scoreAndAssert(sb, actor, id);
      done++;
      if (r) { scored++; console.log(`  ✓ ${name}: icp_fit=${r.icp_fit.toFixed(2)}`); }
      else console.log(`  – ${name}: skipped (no scoreable facts yet)`);
    } catch (e) {
      console.log(`  x ${name}: ${e instanceof Error ? e.message : e}`);
    }
    if (THROTTLE_MS) await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }
  console.log(`\n✓ ${scored}/${done} accounts scored`);
}
main().catch((e) => { console.error(e); process.exit(1); });
