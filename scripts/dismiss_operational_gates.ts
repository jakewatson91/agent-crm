/**
 * Close all open gates whose policy is operational (agent-internal rejection),
 * not human-actionable. These should never have been gates per CLAUDE.md — gates
 * are for irreversible actions a human must approve. The drafter/poster now emit
 * `decision` posts for these cases (see inngest/functions/agent_logic.ts), and
 * this script cleans up the 200+ pile that accumulated before that fix shipped.
 *
 * Usage: `pnpm tsx scripts/dismiss_operational_gates.ts` (read-only by default,
 * pass `--apply` to actually update).
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

// Short policy ids the system emits today, all agent-internal rejections.
const OPERATIONAL_POLICIES = new Set([
  'thin_facts',
  'off_icp',
  'draft_already_exists',
  'no_facts_available',
  'unsourced_claim',
  'icp_mismatch_weak_signal',
  'no_active_facts',
  'rate_limit_exceeded',
  'suppression_match',
  'low_confidence',
  'insufficient_confidence',
]);

// LLM-verbose "policy" strings the drafter/poster used when the prompt asked for
// a short id but the model produced a sentence. Plus short policies the prompt
// invented over time. All observed examples are operational rejections
// (lack of confidence / facts / fit / hiring / filter). Pattern-match them.
// Note: `_` is a word character in regex, so `\bhiring\b` won't match
// `no_hiring`. Drop word boundaries — the substring match is what we want.
const OPERATIONAL_PATTERNS = [
  /insufficient/i,
  /confidence/i,
  /lack of/i,
  /below/i,
  /need more/i,
  /need to/i,
  /not enough/i,
  /icp/i,
  /fit/i,
  /hiring/i,
  /filter/i,
  /drafter/i,
  /no_fact/i,
  /no_citable/i,
  /no_icp/i,
  /citation/i,
  /active_fact/i,
  /suppression/i,
  /outside_icp/i,
  /prospecting/i,
  /audit/i,
  /assess/i,
  /request more/i,
];

function isOperational(policy: string | null | undefined): boolean {
  if (!policy) return false;
  if (OPERATIONAL_POLICIES.has(policy)) return true;
  return OPERATIONAL_PATTERNS.some((re) => re.test(policy));
}

async function main() {
  const apply = process.argv.includes('--apply');
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  const gates = await sb.from('gates')
    .select('id, policy, requested_by_agent, requested_at, decided_at')
    .is('decided_at', null)
    .order('requested_at', { ascending: true });
  if (gates.error) throw gates.error;
  const open = gates.data ?? [];
  console.log(`open gates: ${open.length}`);

  const byPolicy = new Map<string, number>();
  for (const g of open as any[]) byPolicy.set(g.policy, (byPolicy.get(g.policy) ?? 0) + 1);
  console.log('open by policy:');
  for (const [p, c] of [...byPolicy.entries()].sort((a, b) => b[1] - a[1])) {
    const marker = isOperational(p) ? '[op]' : '[?]';
    console.log(`  ${marker} ${p}: ${c}`);
  }

  const toClose = (open as any[]).filter((g) => isOperational(g.policy));
  console.log(`\nwill close: ${toClose.length} operational gates`);
  console.log(`will skip:  ${open.length - toClose.length} (truly human-actionable)`);

  if (!apply) {
    console.log('\nDry run. Re-run with --apply to actually update.');
    return;
  }

  // Update in chunks of 200.
  const ids = toClose.map((g) => g.id);
  const chunkSize = 200;
  let closed = 0;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const upd = await sb.from('gates')
      .update({ decision: 'reject', decided_at: new Date().toISOString() })
      .in('id', chunk);
    if (upd.error) {
      console.error(`chunk ${i}: ${upd.error.message}`);
      continue;
    }
    closed += chunk.length;
    process.stdout.write(`  closed ${closed}/${ids.length}\r`);
  }
  console.log(`\nclosed: ${closed} operational gates`);
}

main().catch((e) => { console.error(e); process.exit(1); });
