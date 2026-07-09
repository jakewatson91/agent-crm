/**
 * One-shot: rescore every entity in the workspace. Use after a major ICP change
 * when waiting for the 30-min cron isn't acceptable. Idempotent via supersede.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

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
  // returns null for other kinds). Restrict here so we don't burn loop cycles —
  // and on free-tier LLMs, rate-limit budget — attempting contacts/products.
  const accts = await sb.from('entities').select('id')
    .eq('workspace_id', WS).eq('kind', 'account').is('archived_at', null);
  const acctIds = new Set(((accts.data ?? []) as Array<{ id: string }>).map((r) => r.id));
  const facts = await sb.from('facts').select('subject_entity').eq('workspace_id', WS).is('supersedes', null);
  const entityIds = [...new Set(((facts.data ?? []) as Array<{ subject_entity: string }>).map((r) => r.subject_entity))]
    .filter((id) => acctIds.has(id));

  // Throttle between calls so a burst doesn't trip free-tier per-minute limits.
  // Override with THROTTLE_MS=0 for a paid model with no rate concerns.
  const THROTTLE_MS = process.env.THROTTLE_MS ? Number(process.env.THROTTLE_MS) : 500;
  console.log(`scoring ${entityIds.length} accounts (throttle ${THROTTLE_MS}ms)…`);

  let done = 0, scored = 0;
  for (const id of entityIds) {
    try {
      const r = await scoreAndAssert(sb, actor, id);
      done++;
      if (r) { scored++; process.stdout.write('.'); }
      else process.stdout.write('-');
    } catch {
      process.stdout.write('x');
    }
    if (done % 50 === 0) process.stdout.write(` ${done}\n`);
    if (THROTTLE_MS) await new Promise((res) => setTimeout(res, THROTTLE_MS));
  }
  console.log(`\n✓ ${scored}/${done} accounts scored (rest skipped: already-fresh or rate-limited)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
