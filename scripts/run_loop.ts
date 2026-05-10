/**
 * Polling loop for "run it for a week" without Inngest.
 *
 * Every INTERVAL_MIN (default 60), for each active workspace:
 *   1. Trigger every active source (via /api/sources/run-now).
 *   2. Process any signals from the last INTERVAL_MIN that haven't fired through agents.
 *
 * Run this in tmux, nohup, or a screen session and leave it. It's the simplest path to
 * a always-on background loop without deploying Inngest. Stop with Ctrl-C.
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY (and any provider keys)
 *   NEXT_BASE_URL=http://localhost:3000  (override if Next.js runs elsewhere)
 *   INTERVAL_MIN=60                       (override loop interval)
 *
 * Usage:
 *   pnpm dev &                            # Next.js must be running
 *   pnpm loop                             # this script
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runAgent } from '../inngest/functions/agent_logic.js';

const NEXT_BASE_URL = process.env.NEXT_BASE_URL ?? 'http://localhost:3000';
const INTERVAL_MIN = parseInt(process.env.INTERVAL_MIN ?? '60', 10);

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function tick() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] tick`);

  // 1. Find all active sources across all workspaces.
  const sources = await sb
    .from('sources')
    .select('id, workspace_id, connector_type, name')
    .eq('active', true);
  if (sources.error) { console.error('  source list failed:', sources.error.message); return; }
  console.log(`  ${sources.data?.length ?? 0} active sources`);

  for (const s of sources.data ?? []) {
    try {
      const res = await fetch(`${NEXT_BASE_URL}/api/sources/run-now`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: s.id }),
      });
      const j = await res.json();
      const summary = j.summary ?? j;
      console.log(`  [${s.connector_type}/${s.name}] signals=${summary.signals_created ?? 0} entities=${summary.entities_created ?? 0} skipped=${summary.skipped ?? 0} errors=${(summary.errors ?? []).length}`);
    } catch (e) {
      console.error(`  [${s.connector_type}/${s.name}] error:`, e instanceof Error ? e.message : String(e));
    }
  }

  // 2. Process any signals from the last INTERVAL_MIN that haven't been processed by agents.
  //    A signal is "unprocessed" if no channel_post has it in its causal chain — but we don't
  //    track that directly, so we just process every signal in the window. Agents are idempotent
  //    via prompt_hash + content_hash, so re-running on already-processed signals creates no
  //    new noise (the post would just duplicate; we skip by checking if we already produced one).
  const since = new Date(Date.now() - INTERVAL_MIN * 60_000).toISOString();
  const sigs = await sb
    .from('signals')
    .select('id, workspace_id, type, source_event_id, observed_at')
    .gte('observed_at', since)
    .order('observed_at', { ascending: true });
  if (sigs.error) { console.error('  signal list failed:', sigs.error.message); return; }
  console.log(`  ${sigs.data?.length ?? 0} signals in window`);

  // For each signal, find subscriptions that match and don't already have a post on this signal.
  // Enrichers run first so scorers/drafters see fresh facts.
  let runs = 0;
  let posted = 0;
  for (const sig of sigs.data ?? []) {
    const m = await sb.rpc('match_signal_to_subscriptions', { p_signal_id: sig.id });
    if (m.error) continue;
    const matches = (m.data ?? []) as Array<{ subscription_id: string; owner_kind: 'agent' | 'user'; owner_id: string }>;

    const subBehaviors = await sb
      .from('subscriptions')
      .select('id, agent_behavior')
      .in('id', matches.map((mt) => mt.subscription_id));
    const behaviorById = new Map((subBehaviors.data ?? []).map((s) => [s.id as string, (s.agent_behavior as string) ?? 'claim_poster']));
    const sorted = [...matches].sort((a, b) => {
      const order: Record<string, number> = { enricher: 0, claim_poster: 1, drafter: 2 };
      const ba = behaviorById.get(a.subscription_id) ?? 'claim_poster';
      const bb = behaviorById.get(b.subscription_id) ?? 'claim_poster';
      return (order[ba] ?? 1) - (order[bb] ?? 1);
    });

    for (const match of sorted) {
      if (match.owner_kind !== 'agent') continue;

      // Idempotency: skip if this agent already posted on this signal's parent event.
      const existing = await sb
        .from('events')
        .select('id', { head: true, count: 'exact' })
        .eq('actor_id', match.owner_id)
        .eq('parent_event_id', sig.source_event_id);
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
    }
  }
  console.log(`  ${runs} agent runs, ${posted} posts created`);
}

async function main() {
  console.log(`agent-crm run loop starting · interval=${INTERVAL_MIN}m · base=${NEXT_BASE_URL}`);
  await tick();
  setInterval(() => { tick().catch((e) => console.error('tick error:', e)); }, INTERVAL_MIN * 60_000);
  // Keep alive
  await new Promise(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
