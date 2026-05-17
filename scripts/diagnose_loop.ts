/**
 * Diagnose why the drafter loop isn't producing drafts/gates.
 *
 *   pnpm tsx scripts/diagnose_loop.ts
 *
 * Walks four checkpoints to find the actual break:
 *   1. Did rescore_all update sub-score facts for top entities? (or did
 *      something cause it to skip them?)
 *   2. What drafter subscriptions exist and what do their filters look like?
 *   3. Recent action_selector_skip events — actual reasons signals didn't draft
 *   4. Recent agent_run_metrics — is the drafter LLM even being called?
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
  const ws = await sb.from('workspaces').select('id').like('name', 'demo · agent-crm%').limit(1).single();
  const WS = ws.data!.id as string;
  const DAY = 86400_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  // ---- 1. Top-entity sub-score facts ----
  console.log('=== 1. SUB-SCORE FACTS ON TOP 5 ENTITIES (proof rescore worked) ===');
  const icp = await sb.from('facts').select('subject_entity, object_text').eq('workspace_id', WS).eq('predicate', 'icp_fit').is('supersedes', null).limit(2000);
  const topIds = ((icp.data ?? []) as Array<{ subject_entity: string; object_text: string }>)
    .map((r) => ({ id: r.subject_entity, score: parseFloat(r.object_text) }))
    .sort((a, b) => b.score - a.score).slice(0, 5).map((x) => x.id);
  const ents = await sb.from('entities').select('id, name').in('id', topIds);
  const nameById = new Map(((ents.data ?? []) as Array<{ id: string; name: string }>).map((e) => [e.id, e.name]));
  const subFacts = await sb.from('facts')
    .select('subject_entity, predicate, object_text, created_at')
    .in('subject_entity', topIds)
    .is('supersedes', null)
    .order('created_at', { ascending: false })
    .limit(500);
  for (const eid of topIds) {
    const rows = ((subFacts.data ?? []) as any[]).filter((r) => r.subject_entity === eid);
    const scoreRows = rows.filter((r) => r.predicate.startsWith('score_') || r.predicate === 'icp_fit');
    console.log(`\n${nameById.get(eid)} (${eid.slice(0, 8)})`);
    if (!scoreRows.length) { console.log('  NO SCORE FACTS — rescore didn\'t touch this entity'); continue; }
    for (const r of scoreRows) {
      const age = ((Date.now() - new Date(r.created_at).getTime()) / 3600_000).toFixed(1);
      console.log(`  ${r.predicate.padEnd(24)} ${r.object_text}    (${age}h old)`);
    }
    const dropped = rows.find((r) => r.predicate === 'dropped_until');
    if (dropped) console.log(`  dropped_until=${dropped.object_text}  <-- this blocks rescoring`);
  }

  // ---- 2. Drafter subscriptions ----
  console.log('\n\n=== 2. DRAFTER SUBSCRIPTIONS ===');
  const subs = await sb.from('subscriptions')
    .select('id, name, owner_id, semantic, structured_filter, threshold, action_on_match, active, fact_filter')
    .eq('workspace_id', WS);
  const drafterSubs = ((subs.data ?? []) as any[]).filter((s) => /draft/i.test(s.owner_id ?? '') || /draft/i.test(s.name ?? ''));
  if (!drafterSubs.length) {
    console.log('  NO drafter subscriptions found — drafter agent will never run on signals.');
    console.log('  All workspace subscriptions:');
    for (const s of (subs.data ?? []) as any[]) console.log(`    [${s.active ? 'ON ' : 'off'}] ${s.owner_id?.padEnd(28)} ${s.name}`);
  } else {
    for (const s of drafterSubs) {
      console.log(`\n  [${s.active ? 'ON ' : 'off'}] ${s.name}  owner=${s.owner_id}`);
      console.log(`      threshold=${s.threshold}  action_on_match=${s.action_on_match}`);
      console.log(`      semantic="${(s.semantic ?? '').slice(0, 80)}"`);
      console.log(`      structured_filter=${JSON.stringify(s.structured_filter)}`);
      if (s.fact_filter) console.log(`      fact_filter=${JSON.stringify(s.fact_filter)}`);
    }
  }

  // ---- 3. Recent action_selector_skip events with full payload ----
  console.log('\n\n=== 3. RECENT action_selector_skip EVENTS (last 7d) ===');
  const skips = await sb.from('events')
    .select('created_at, payload, target_id, actor_id')
    .eq('workspace_id', WS).eq('action', 'action_selector_skip')
    .gte('created_at', ago(7 * DAY))
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`  ${skips.data?.length ?? 0} events`);
  for (const e of (skips.data ?? []) as any[]) {
    const t = (e.created_at as string).slice(5, 16);
    const p = e.payload ?? {};
    console.log(`  ${t} action=${p.action?.padEnd(14)} policy=${p.policy?.padEnd(28)} entity=${(e.target_id ?? '').slice(0, 8)}`);
  }

  // ---- 4. Recent agent runs (any behavior) ----
  console.log('\n\n=== 4. RECENT agent_run_metrics (last 24h) ===');
  const runs = await sb.from('events')
    .select('created_at, payload, actor_id')
    .eq('workspace_id', WS).eq('action', 'agent_run_metrics')
    .gte('created_at', ago(DAY))
    .order('created_at', { ascending: false })
    .limit(20);
  console.log(`  ${runs.data?.length ?? 0} runs in 24h`);
  const byBehavior = new Map<string, number>();
  for (const r of (runs.data ?? []) as any[]) {
    const b = r.payload?.behavior ?? '?';
    byBehavior.set(b, (byBehavior.get(b) ?? 0) + 1);
  }
  for (const [b, n] of byBehavior) console.log(`    ${b.padEnd(20)} ${n}`);

  // ---- 5. Recent signals → did they match drafter subscriptions? ----
  console.log('\n\n=== 5. RECENT subscription.matched EVENTS (last 24h) ===');
  const matches = await sb.from('events')
    .select('created_at, payload, actor_id')
    .eq('workspace_id', WS).eq('action', 'subscription.matched')
    .gte('created_at', ago(DAY))
    .order('created_at', { ascending: false })
    .limit(30);
  const matchByOwner = new Map<string, number>();
  for (const r of (matches.data ?? []) as any[]) {
    const o = r.payload?.subscription_owner_id ?? '?';
    matchByOwner.set(o, (matchByOwner.get(o) ?? 0) + 1);
  }
  console.log(`  ${matches.data?.length ?? 0} matches in 24h:`);
  for (const [o, n] of matchByOwner) console.log(`    ${o.padEnd(28)} ${n}`);

  console.log('\n\n=== READ THIS ===');
  console.log('- Section 1: each top entity should show score_industry_match, score_signal_strength,');
  console.log('  score_evidence_depth, score_recency, score_graph_proximity, score_total, icp_fit.');
  console.log('  If any are missing → rescore did NOT update them.');
  console.log('- Section 2: at least one ACTIVE drafter subscription, threshold reasonable.');
  console.log('- Section 3: shows what action_selector decided on recent signals. If everything is');
  console.log('  no_threshold_met → score_signal_strength on those entities is below 0.7.');
  console.log('- Section 4: shows whether drafter behavior is even firing. drafter=0 → loop is dead');
  console.log('  upstream (subscription not matching or agent disabled).');
  console.log('- Section 5: which subscriptions are matching signals. If no drafter ones → match_signal');
  console.log('  is filtering them out at the subscription layer.');
}
main().catch((e) => { console.error(e); process.exit(1); });
