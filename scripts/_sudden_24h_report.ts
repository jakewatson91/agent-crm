import { config } from 'dotenv';
config({ path: '/Users/jakewatson/src/agent-crm/.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const since24h = new Date(Date.now() - 24 * 3600e3).toISOString();
const PAGE = 1000;

async function pageAll<T>(build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 30000; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) { console.error('page error:', error); break; }
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
}

async function main() {
  // ---- 1. events last 24h grouped by action ----
  const events = await pageAll<{ action: string; created_at: string; actor_id: string | null; payload: unknown }>(
    (from, to) => sb.from('events').select('action, created_at, actor_id, payload')
      .eq('workspace_id', WS).gte('created_at', since24h).order('created_at', { ascending: true }).range(from, to)
  );
  const byAction = new Map<string, number>();
  for (const e of events) byAction.set(e.action, (byAction.get(e.action) ?? 0) + 1);
  console.log(`=== events last 24h: ${events.length} total ===`);
  for (const [a, n] of [...byAction.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${a}: ${n}`);

  // hourly cadence
  const byHour = new Map<string, number>();
  for (const e of events) byHour.set(e.created_at.slice(0, 13), (byHour.get(e.created_at.slice(0, 13)) ?? 0) + 1);
  console.log('\n=== hourly event cadence (UTC) ===');
  for (const [h, n] of [...byHour.entries()].sort()) console.log(`  ${h}: ${n}`);

  // ---- 2. error-ish events ----
  const errish = events.filter((e) => /error|fail|denied|wall|pause/i.test(e.action));
  console.log(`\n=== error/pause-ish events: ${errish.length} ===`);
  for (const e of errish.slice(-20)) console.log(`  ${e.created_at}  ${e.action}  ${JSON.stringify(e.payload)?.slice(0, 200)}`);

  // ---- 3. agent dispatch/run metrics detail ----
  const agentEv = events.filter((e) => ['agent_dispatch_result', 'agent_run_metrics'].includes(e.action));
  console.log(`\n=== agent dispatch/run events: ${agentEv.length} ===`);
  for (const e of agentEv.slice(-25)) console.log(`  ${e.created_at}  ${e.action}  ${JSON.stringify(e.payload)?.slice(0, 220)}`);

  // ---- 4. research cadence ----
  const research = events.filter((e) => e.action.startsWith('research'));
  console.log(`\n=== research events: ${research.length} ===`);
  for (const e of research.slice(-15)) console.log(`  ${e.created_at}  ${e.action}  ${JSON.stringify(e.payload)?.slice(0, 180)}`);

  // ---- 5. signals last 24h ----
  const { count: sigCount } = await sb.from('signals').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).gte('created_at', since24h);
  const { data: sigSample } = await sb.from('signals').select('id, created_at, source_id, structured_tags, summary')
    .eq('workspace_id', WS).gte('created_at', since24h).order('created_at', { ascending: false }).limit(10);
  console.log(`\n=== signals last 24h: ${sigCount} ===`);
  for (const s of sigSample ?? []) console.log(`  ${s.created_at}  src=${s.source_id?.slice(0, 8)}  ${(s.summary ?? JSON.stringify(s.structured_tags))?.slice(0, 140)}`);

  // ---- 6. facts last 24h by predicate ----
  const facts24 = await pageAll<{ predicate: string; observed_at: string }>(
    (from, to) => sb.from('facts').select('predicate, observed_at')
      .eq('workspace_id', WS).gte('observed_at', since24h).range(from, to)
  );
  const byPred = new Map<string, number>();
  for (const f of facts24) byPred.set(f.predicate, (byPred.get(f.predicate) ?? 0) + 1);
  console.log(`\n=== facts asserted last 24h: ${facts24.length} ===`);
  for (const [p, n] of [...byPred.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${p}: ${n}`);

  // ---- 7. current score_total distribution ----
  const scoreFacts = await pageAll<{ id: string; object_text: string; supersedes: string | null; observed_at: string; subject_entity: string }>(
    (from, to) => sb.from('facts').select('id, object_text, supersedes, observed_at, subject_entity')
      .eq('workspace_id', WS).eq('predicate', 'score_total').range(from, to)
  );
  const pointed = new Set(scoreFacts.map((f) => f.supersedes).filter(Boolean));
  const current = scoreFacts.filter((f) => !pointed.has(f.id));
  const hist = new Array(10).fill(0);
  let bad = 0;
  const vals: number[] = [];
  for (const f of current) {
    const v = parseFloat(f.object_text);
    if (Number.isNaN(v)) { bad++; continue; }
    vals.push(v);
    const decile = Math.min(9, Math.floor(v / 10));
    hist[decile]++;
  }
  console.log(`\n=== current score_total: ${current.length} entities (${bad} non-numeric) ===`);
  for (let i = 0; i < 10; i++) console.log(`  decile ${i + 1} (${i * 10}-${i * 10 + 9}): ${hist[i]}`);
  vals.sort((a, b) => a - b);
  const q = (p: number) => vals[Math.floor(p * (vals.length - 1))];
  if (vals.length) console.log(`  min=${q(0)} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)} max=${q(1)}`);

  // freshness: how many current scores were written in last 24h
  const fresh = current.filter((f) => f.observed_at >= since24h).length;
  console.log(`  current scores written in last 24h: ${fresh}`);

  // sample of most common value cluster
  const valCounts = new Map<string, number>();
  for (const f of current) valCounts.set(f.object_text, (valCounts.get(f.object_text) ?? 0) + 1);
  console.log('  top values:', [...valCounts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([v, n]) => `${v}×${n}`).join('  '));

  // ---- 8. sources state ----
  const { data: srcs } = await sb.from('sources').select('id, name, kind, active, config')
    .eq('workspace_id', WS);
  console.log(`\n=== sources ===`);
  for (const s of srcs ?? []) {
    const cfg = s.config as Record<string, unknown> | null;
    console.log(`  ${s.name} (${s.kind}) active=${s.active} cron=${cfg?.cron ?? '-'} last_run=${cfg?.last_run_at ?? cfg?.watermark ?? '-'}`);
  }

  // ---- 9. gates ----
  const { count: pendingGates } = await sb.from('gates').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).is('decided_at', null);
  const { count: gates24 } = await sb.from('gates').select('id', { count: 'exact', head: true })
    .eq('workspace_id', WS).gte('created_at', since24h);
  console.log(`\n=== gates: pending=${pendingGates} created_24h=${gates24} ===`);
  const { data: recentGates } = await sb.from('gates').select('id, created_at, kind, decided_at, payload')
    .eq('workspace_id', WS).order('created_at', { ascending: false }).limit(5);
  for (const g of recentGates ?? []) console.log(`  ${g.created_at}  kind=${g.kind}  decided=${g.decided_at ?? 'PENDING'}  ${JSON.stringify(g.payload)?.slice(0, 120)}`);

  // ---- 10. pipeline / policy state ----
  const { data: ws } = await sb.from('workspaces').select('policy').eq('id', WS).single();
  const pol = ws?.policy as Record<string, unknown> | null;
  console.log(`\n=== policy.pipeline ===`, JSON.stringify(pol?.pipeline ?? null));
  console.log(`=== policy.scoring (keys) ===`, pol ? Object.keys(pol).join(', ') : 'none');

  // ---- 11. domain coverage ----
  let withDomain = 0, total = 0;
  const ents = await pageAll<{ attributes: Record<string, unknown> | null }>(
    (from, to) => sb.from('entities').select('attributes').eq('workspace_id', WS).range(from, to)
  );
  for (const e of ents) {
    total++;
    const d = e.attributes?.domain;
    if (typeof d === 'string' && d.length > 0) withDomain++;
  }
  console.log(`\n=== domain coverage: ${withDomain}/${total} entities ===`);
}
main().catch((e) => { console.error(e); process.exit(1); });
