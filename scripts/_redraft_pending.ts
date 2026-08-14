/**
 * Redraft every message sitting in the approval inbox, through the real drafter.
 *
 * Uses runAgent(behavior=drafter), the same call the nightly advance pass makes,
 * so the new drafts get the current rules, the current problem list, the audit
 * checks and a real gate. Nothing here re-implements the drafter.
 *
 * Order matters: the replacement is written FIRST and the old gate is only
 * closed once a new draft actually exists. If the drafter now refuses an account
 * (today's rules refuse more than yesterday's did), the old draft stays in the
 * inbox rather than leaving nothing behind.
 *
 * The old gate is closed by writing the decision straight to the row. That is
 * deliberate: the /api/gates/decide route's reject path also asserts
 * `outreach_rejected_at` on the entity, which suppresses it from future passes,
 * and these are not rejections. An event is recorded so the audit trail still
 * explains where the draft went.
 *
 * Usage: pnpm tsx scripts/_redraft_pending.ts          (shows what it would do)
 *        pnpm tsx scripts/_redraft_pending.ts --apply
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runAgent } from '../inngest/functions/agent_logic.js';

const WS = process.env.WORKSPACE_ID ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const APPLY = process.argv.includes('--apply');

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const { data: subRow } = await sb.from('subscriptions')
    .select('id, owner_id').eq('workspace_id', WS).eq('agent_behavior', 'drafter').eq('active', true)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  const sub = subRow as { id: string; owner_id: string } | null;
  if (!sub) throw new Error('no active drafter subscription on this workspace');

  const { data: gateRows } = await sb.from('gates')
    .select('id, policy, requested_at, channel_post_id')
    .eq('workspace_id', WS).is('decision', null).eq('policy', 'outreach_send')
    .order('requested_at');
  const gates = (gateRows ?? []) as Array<{ id: string; policy: string; requested_at: string; channel_post_id: string }>;
  console.log(`${gates.length} drafts waiting for approval${APPLY ? '' : '  (dry run, pass --apply to redraft)'}\n`);

  for (const g of gates) {
    const { data: postRow } = await sb.from('channel_posts')
      .select('id, body, channel_id, channels!inner(account_entity_id)')
      .eq('id', g.channel_post_id).maybeSingle();
    const post = postRow as any;
    const entity_id = post?.channels?.account_entity_id as string | undefined;
    if (!entity_id) { console.log(`── gate ${g.id.slice(0, 8)}: no account behind it, skipping`); continue; }
    const { data: ent } = await sb.from('entities').select('name').eq('id', entity_id).maybeSingle();
    const name = (ent as any)?.name ?? entity_id.slice(0, 8);

    console.log(`── ${name}`);
    console.log(`   old: ${String(post.body ?? '').slice(0, 140)}…`);
    if (!APPLY) continue;

    // Same trigger-fact choice advance_accounts makes: a hook fact if there is
    // one, otherwise any current non-score fact.
    const { data: factRows } = await sb.from('facts')
      .select('id, predicate, supersedes').eq('workspace_id', WS).eq('subject_entity', entity_id);
    const rows = (factRows ?? []) as Array<{ id: string; predicate: string; supersedes: string | null }>;
    const pointed = new Set(rows.map((r) => r.supersedes).filter((x): x is string => !!x));
    const current = rows.filter((r) => !pointed.has(r.id) && !r.predicate.startsWith('score_') &&
      !['icp_fit', 'icp_fit_breakdown', 'contact_score', 'dropped_until', 'outreach_cooldown_until'].includes(r.predicate));
    const HOOKS = ['buying_signal', 'recent_event', 'pain_observed', 'hiring_role'];
    const fact_id = (current.find((r) => HOOKS.includes(r.predicate)) ?? current[0])?.id;
    if (!fact_id) { console.log('   no fact to trigger on, left alone\n'); continue; }

    const r = await runAgent(sb as any, { workspace_id: WS, agent: sub.owner_id, subscription_id: sub.id, fact_id });
    const action = (r as any).action;
    const reason = (r as any).reason;

    if (!(r.ok && action === 'post_touch_draft')) {
      console.log(`   drafter did not produce a new draft (${reason ?? action}). OLD DRAFT LEFT IN PLACE.\n`);
      continue;
    }

    const newPostId = (r as any).channel_post_id as string | undefined;
    const { data: fresh } = await sb.from('channel_posts').select('body').eq('id', newPostId ?? '').maybeSingle();
    console.log(`   new: ${String((fresh as any)?.body ?? '').slice(0, 140)}…`);

    const { error: closeErr } = await sb.from('gates').update({
      decision: 'reject',
      decided_at: new Date().toISOString(),
      resolution: { note: `Superseded by a redraft on ${new Date().toISOString().slice(0, 10)}. Not a rejection of the account.`, superseded_by: newPostId ?? null },
    }).eq('id', g.id);
    if (closeErr) { console.log(`   could not close the old gate: ${closeErr.message}\n`); continue; }

    await sb.from('events').insert({
      workspace_id: WS, actor_kind: 'agent', actor_id: sub.owner_id,
      action: 'draft_superseded', target_kind: 'entity', target_id: entity_id,
      payload: { old_gate: g.id, old_post: g.channel_post_id, new_post: newPostId ?? null, reason: 'redrafted under current rules' },
    });
    console.log('   old draft closed, replacement is in the inbox\n');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
