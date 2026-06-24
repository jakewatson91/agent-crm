/**
 * Polling loop that runs the enrichment pipeline without Inngest.
 *
 * Every INTERVAL_MIN (default 60), across every active workspace:
 *   1. Run every active source connector directly -> creates signals.
 *   2. Process signals from the last INTERVAL_MIN through the matched agents
 *      (enricher first), extracting facts + rescoring.
 *
 * Self-contained: connectors are invoked in-process, so no Next.js server has
 * to be running. Run it in tmux/nohup to keep enrichment flowing while Inngest
 * is out of runs (stop with Ctrl-C), or set RUN_ONCE=1 for a single pass and
 * exit — that's the mode the daily launchd job uses.
 *
 * Env:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (and any provider keys)
 *   INTERVAL_MIN=60   loop interval AND the signal lookback window in minutes
 *   RUN_ONCE=1        run one tick then exit (for cron / launchd)
 *
 * Usage:
 *   pnpm loop                 # continuous loop
 *   RUN_ONCE=1 INTERVAL_MIN=1500 pnpm loop   # one daily pass over the last ~25h
 */

import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { runAgent } from '../inngest/functions/agent_logic.js';
import { getConnector } from '../inngest/functions/sources/registry.js';
import { runRetention } from '@agent-crm/tools';

const INTERVAL_MIN = parseInt(process.env.INTERVAL_MIN ?? '60', 10);

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function tick() {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] tick`);

  // 1. Find all active sources across all workspaces.
  const sources = await sb
    .from('sources')
    .select('id, workspace_id, connector_type, name, config, last_run_at')
    .eq('active', true);
  if (sources.error) { console.error('  source list failed:', sources.error.message); return; }
  console.log(`  ${sources.data?.length ?? 0} active sources`);

  // Run each connector in-process (no HTTP / no Next.js server), mirroring
  // /api/sources/run-now: execute conn.run then write last_run_* back so
  // watermarked connectors don't re-fetch from scratch on the next tick.
  for (const s of sources.data ?? []) {
    try {
      const conn = getConnector(s.connector_type as string);
      if (!conn) { console.error(`  [${s.connector_type}/${s.name}] unknown connector_type`); continue; }
      const out = await conn.run({
        supabase: sb,
        workspace_id: s.workspace_id as string,
        source_id: s.id as string,
        config: (s.config ?? {}) as Record<string, unknown>,
        last_run_at: (s.last_run_at as string | null) ?? null,
      });
      await sb.from('sources').update({
        last_run_at: new Date().toISOString(),
        last_run_status: out.errors.length === 0 ? 'ok' : 'error',
        last_run_summary: {
          signals_created: out.signals_created,
          entities_created: out.entities_created,
          skipped: out.skipped,
          errors: out.errors.slice(0, 5),
        },
      }).eq('id', s.id);
      console.log(`  [${s.connector_type}/${s.name}] signals=${out.signals_created} entities=${out.entities_created} skipped=${out.skipped} errors=${out.errors.length}`);
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

  // 3. Retention pass — bound the unbounded tables (signals embeddings, telemetry
  //    events). Internally throttled to ~once/day per workspace, so calling it
  //    every tick is safe. No-op unless workspaces.policy.retention is set.
  const wss = await sb.from('workspaces').select('id');
  for (const w of wss.data ?? []) {
    try {
      const r = await runRetention(sb, w.id as string);
      if (!r.skipped && (r.embeddings_archived > 0 || r.events_pruned > 0)) {
        console.log(`  [retention ${w.id}] embeddings_archived=${r.embeddings_archived} events_pruned=${r.events_pruned}`);
      }
    } catch (e) {
      console.error(`  [retention ${w.id}] error:`, e instanceof Error ? e.message : String(e));
    }
  }

  // 4. Weekly HNSW reindex. Nulling old embeddings (step 3) frees the heap via
  //    autovacuum, but the HNSW index file only shrinks on REINDEX. CONCURRENTLY
  //    so it never locks matching; that can't run in a function or over PostgREST,
  //    so it needs the direct connection the launchd loop has. Throttled to 7d and
  //    gated on there actually being nulled embeddings to reclaim.
  try {
    const wsList = (wss.data ?? []) as Array<{ id: string }>;
    if (wsList.length && process.env.SUPABASE_DB_URL) {
      const lastReindex = await sb.from('events')
        .select('created_at').eq('action', 'reindex_run')
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      const due = !lastReindex.data || Date.now() - new Date(lastReindex.data.created_at).getTime() > 7 * 86400_000;
      if (due) {
        const nulled = await sb.from('signals').select('id', { head: true, count: 'exact' }).is('embedding', null);
        if ((nulled.count ?? 0) > 0) {
          const { default: pg } = await import('pg');
          const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
          await client.connect();
          console.log('  [reindex] REINDEX INDEX CONCURRENTLY signals_embedding_hnsw ...');
          await client.query('reindex index concurrently signals_embedding_hnsw');
          await client.end();
          await sb.from('events').insert({
            workspace_id: wsList[0].id, actor_kind: 'system', actor_id: 'retention',
            action: 'reindex_run', target_kind: 'workspace', target_id: wsList[0].id, payload: {},
          });
          console.log('  [reindex] done');
        }
      }
    }
  } catch (e) {
    console.error('  [reindex] error:', e instanceof Error ? e.message : String(e));
  }
}

async function main() {
  const once = process.env.RUN_ONCE === '1';
  console.log(`agent-crm run loop starting · interval=${INTERVAL_MIN}m · once=${once}`);
  await tick();
  if (once) { console.log('RUN_ONCE set — exiting after one tick.'); process.exit(0); }
  setInterval(() => { tick().catch((e) => console.error('tick error:', e)); }, INTERVAL_MIN * 60_000);
  // Keep alive
  await new Promise(() => {});
}
main().catch((e) => { console.error(e); process.exit(1); });
