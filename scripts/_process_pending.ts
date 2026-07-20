/**
 * One-shot: process recent unprocessed signals through the agent pipeline
 * (match -> enricher/claim_poster/drafter) by calling runAgent directly, the
 * same way scripts/run_loop.ts step 2 does — no Inngest Cloud needed. Used to
 * drain signals that piled up while the prod scheduler was down.
 *
 *   SINCE_HOURS=6 WORKSPACE_ID=<uuid> pnpm exec tsx -r dotenv/config scripts/_process_pending.ts
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runAgent } from '../inngest/functions/agent_logic.js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SINCE_HOURS = parseInt(process.env.SINCE_HOURS ?? '6', 10);
const WORKSPACE_ID = process.env.WORKSPACE_ID;

(async () => {
  const since = new Date(Date.now() - SINCE_HOURS * 3600_000).toISOString();
  let q = sb.from('signals').select('id, workspace_id, type, source_event_id, observed_at').gte('observed_at', since).order('observed_at', { ascending: true });
  if (WORKSPACE_ID) q = q.eq('workspace_id', WORKSPACE_ID);
  const sigs = await q;
  if (sigs.error) { console.error('signal list failed:', sigs.error.message); process.exit(1); }
  console.log(`${sigs.data?.length ?? 0} signals in last ${SINCE_HOURS}h`);

  let runs = 0, posted = 0;
  for (const sig of sigs.data ?? []) {
    const m = await sb.rpc('match_signal_to_subscriptions', { p_signal_id: sig.id });
    if (m.error) { console.error(`  match failed ${sig.id.slice(0,8)}:`, m.error.message); continue; }
    const matches = (m.data ?? []) as Array<{ subscription_id: string; owner_kind: 'agent' | 'user'; owner_id: string }>;

    const subBehaviors = await sb.from('subscriptions').select('id, agent_behavior').in('id', matches.map((mt) => mt.subscription_id));
    const behaviorById = new Map((subBehaviors.data ?? []).map((s) => [s.id as string, (s.agent_behavior as string) ?? 'claim_poster']));
    const sorted = [...matches].sort((a, b) => {
      const order: Record<string, number> = { enricher: 0, claim_poster: 1, drafter: 2 };
      return (order[behaviorById.get(a.subscription_id) ?? 'claim_poster'] ?? 1) - (order[behaviorById.get(b.subscription_id) ?? 'claim_poster'] ?? 1);
    });

    for (const match of sorted) {
      if (match.owner_kind !== 'agent') continue;
      const existing = await sb.from('events').select('id', { head: true, count: 'exact' }).eq('actor_id', match.owner_id).eq('parent_event_id', sig.source_event_id);
      if ((existing.count ?? 0) > 0) continue;
      runs++;
      const r = await runAgent(sb, {
        workspace_id: sig.workspace_id as string,
        agent: match.owner_id,
        subscription_id: match.subscription_id,
        signal_id: sig.id as string,
        parent_event_id: String(sig.source_event_id),
      });
      if (r.ok && r.channel_post_id) posted++;
      console.log(`  ${sig.type} -> ${match.owner_id} ok=${r.ok}${r.ok ? '' : ' err=' + (r as any).error}`);
    }
  }
  console.log(`\n${runs} agent runs, ${posted} posts created`);
})();
