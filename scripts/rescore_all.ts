/**
 * One-shot: rescore every entity in the workspace. Use after a major ICP change
 * when waiting for the 30-min cron isn't acceptable. Idempotent via supersede.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert, entityIdsOfType } from '@agent-crm/tools';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  let WS = process.env.WORKSPACE_ID;
  let wsName = WS;
  if (!WS) {
    const ws = await sb.from('workspaces').select('id, name')
      .like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
    if (!ws.data) throw new Error('no workspace');
    WS = ws.data.id as string;
    wsName = ws.data.name;
  }
  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'rescore_all_script' };
  console.log(`workspace: ${wsName}`);

  // Only accounts are scoreable (icp_fit is account-level; the scorer gate
  // returns null for other kinds). entities.kind was dropped in migration
  // 0032 — account-ness now lives only in the (is_a, account) fact, which is
  // what entityIdsOfType reads (paginated, so it's correct past 1000 rows).
  const acctIds = await entityIdsOfType(sb, WS, 'account');
  const entityIds: string[] = [];
  for (let i = 0; i < acctIds.length; i += 200) {
    const chunk = acctIds.slice(i, i + 200);
    const r = await sb.from('entities').select('id').in('id', chunk).is('archived_at', null);
    for (const row of (r.data ?? []) as Array<{ id: string }>) entityIds.push(row.id);
  }

  // Throttle between calls (per worker) so a burst doesn't trip free-tier
  // per-minute limits. Override with THROTTLE_MS=0 for a paid model with no
  // rate concerns. CONCURRENCY runs multiple accounts in flight at once —
  // scoreAndAssert per account is a single LLM + embedding round trip
  // (~15s observed), so a sequential loop over hundreds of accounts is
  // wall-clock-bound by that, not by THROTTLE_MS. Default 1 preserves the
  // old sequential behavior; bump it for a real backfill on a paid model.
  const THROTTLE_MS = process.env.THROTTLE_MS ? Number(process.env.THROTTLE_MS) : 500;
  const CONCURRENCY = process.env.CONCURRENCY ? Number(process.env.CONCURRENCY) : 1;
  console.log(`scoring ${entityIds.length} accounts (throttle ${THROTTLE_MS}ms, concurrency ${CONCURRENCY})…`);

  let done = 0, scored = 0, cursor = 0;
  async function worker() {
    for (;;) {
      const i = cursor++;
      if (i >= entityIds.length) return;
      try {
        const r = await scoreAndAssert(sb, actor, entityIds[i]);
        done++;
        if (r) { scored++; process.stdout.write('.'); }
        else process.stdout.write('-');
      } catch {
        done++;
        process.stdout.write('x');
      }
      if (done % 50 === 0) process.stdout.write(` ${done}\n`);
      if (THROTTLE_MS) await new Promise((res) => setTimeout(res, THROTTLE_MS));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log(`\n✓ ${scored}/${done} accounts scored (rest skipped: already-fresh or rate-limited)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
