/**
 * Manually drive the autonomous loop for recent signals that haven't been processed.
 *
 * Useful when Inngest isn't running (e.g., dev without the inngest-cli, or before deploying).
 * In production the same logic runs via Inngest's match_signal + agent.run functions.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runAgent } from '../inngest/functions/agent_logic.js';

async function main() {
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').order('created_at', { ascending: false }).limit(1).single();
  const WS = ws.data!.id as string;

  const sinceMin = parseInt(process.env.SINCE_MIN ?? '60', 10);
  const since = new Date(Date.now() - sinceMin * 60_000).toISOString();
  const signals = await sb
    .from('signals').select('id, type, observed_at, source_event_id')
    .eq('workspace_id', WS)
    .gte('observed_at', since)
    .order('observed_at', { ascending: true });
  if (signals.error || !signals.data) throw signals.error ?? new Error('no signals');
  console.log(`processing ${signals.data.length} signals from last ${sinceMin}m\n`);

  let runs = 0;
  let posted = 0;
  for (const s of signals.data) {
    const m = await sb.rpc('match_signal_to_subscriptions', { p_signal_id: s.id });
    if (m.error) { console.log(`  ✗ match failed for ${s.id}: ${m.error.message}`); continue; }
    const matches = (m.data ?? []) as Array<{ subscription_id: string; owner_kind: 'agent'|'user'; owner_id: string; action_on_match: string; similarity: number }>;
    if (matches.length === 0) {
      console.log(`  · ${s.type} (${s.id.slice(0,8)}): no subscription matches`);
      continue;
    }

    // Workflow ordering: enrichers run first so that downstream scorers/drafters
    // see the freshly-asserted facts when they build context. Otherwise scorers
    // produce generic output ("fits ICP") with cites=0 because no facts existed
    // when they ran.
    const subBehaviors = await sb
      .from('subscriptions')
      .select('id, agent_behavior')
      .in('id', matches.map((m) => m.subscription_id));
    const behaviorById = new Map((subBehaviors.data ?? []).map((s) => [s.id as string, (s.agent_behavior as string) ?? 'claim_poster']));
    const sortedMatches = [...matches].sort((a, b) => {
      const ba = behaviorById.get(a.subscription_id) ?? 'claim_poster';
      const bb = behaviorById.get(b.subscription_id) ?? 'claim_poster';
      const order: Record<string, number> = { enricher: 0, claim_poster: 1, drafter: 2 };
      return (order[ba] ?? 1) - (order[bb] ?? 1);
    });

    for (const match of sortedMatches) {
      if (match.owner_kind !== 'agent') continue;
      runs++;
      const r = await runAgent(sb, {
        workspace_id: WS,
        agent: match.owner_id,
        subscription_id: match.subscription_id,
        signal_id: s.id,
        parent_event_id: String(s.source_event_id),
      });
      const tag = r.ok ? '✓' : '✗';
      const beh = behaviorById.get(match.subscription_id) ?? 'claim_poster';
      console.log(`  ${tag} [${beh.padEnd(12)}] ${s.type} ${s.id.slice(0,8)} → ${match.owner_id} → ${r.action} ${r.ok ? `(post=${r.channel_post_id?.slice(0,8)})` : `(${r.reason})`}`);
      if (r.ok && r.channel_post_id) posted++;
    }
  }
  console.log(`\nsummary: ${runs} agent runs, ${posted} posts created`);
}
main().catch((e) => { console.error(e); process.exit(1); });
