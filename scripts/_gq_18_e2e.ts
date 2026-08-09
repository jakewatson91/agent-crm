/**
 * End-to-end run of the whole loop, locally: pick accounts the way the
 * dispatcher would, research them, enrich the signals that survive, and report
 * the facts grouped by the brief question they answer.
 *
 * The enricher is invoked through runAgent directly. Inngest event DISPATCH
 * fails from a laptop (401, no event key), but that is only the messenger —
 * runAgent itself runs fine, which is what _enrich_research_local.ts has always
 * done.
 *
 * SPENDS EXA: ~5 searches per account.
 *
 * Usage: pnpm tsx scripts/_gq_18_e2e.ts [n_accounts] [--apply]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveBrief, currentFactRows } from '@agent-crm/tools';
import { runEntityResearch } from '../inngest/functions/research.ts';
import { runAgent } from '../inngest/functions/agent_logic.ts';

const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const N = Number(process.argv[2] ?? 6);
const APPLY = process.argv.includes('--apply');

(async () => {
  const sb = createServerClient();
  const policy = await getPolicy(sb as any, WS);
  const brief = resolveBrief(policy);

  // Pick like the dispatcher: highest CURRENT icp_fit, with a domain.
  // Not `.is('supersedes', null)` — that returns the first-ever score, which is
  // the bug this session fixed in the dispatcher. currentFactRows is the one
  // implementation; every version of the score has to be read for it to work.
  const fits = (await sb.from('facts').select('id, subject_entity, object_text, observed_at, supersedes')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit').limit(5000)).data ?? [];
  const current = currentFactRows(fits as any[], (r: any) => r.subject_entity);
  const ranked = [...current.values()].map((r: any) => ({ id: r.subject_entity, fit: Number(r.object_text) }))
    .filter((r) => Number.isFinite(r.fit)).sort((a, b) => b.fit - a.fit);

  const picked: Array<{ id: string; name: string; fit: number }> = [];
  for (const r of ranked) {
    if (picked.length >= N) break;
    const e = (await sb.from('entities').select('id, name, attributes').eq('id', r.id).maybeSingle()).data as any;
    if (!e?.attributes?.domain) continue;
    picked.push({ id: e.id, name: e.name, fit: r.fit });
  }
  console.log(`picked ${picked.length} accounts by icp_fit (with a domain):`);
  for (const p of picked) console.log(`   ${p.fit.toFixed(2)}  ${p.name}`);
  if (!APPLY) { console.log('\n(dry run — pass --apply to spend Exa and run)'); return; }

  const startedAt = new Date().toISOString();
  const newSignals: string[] = [];

  console.log('\n=== RESEARCH ===');
  for (const p of picked) {
    const r: any = await runEntityResearch(sb, {
      workspace_id: WS, entity_id: p.id, entity_name: p.name,
      reason: 'manual:_gq_18_e2e', angle_count: 5, kind: 'account',
    } as any);
    console.log(`  ${p.name.padEnd(24)} searches=${r.searches ?? 0} kept=${r.signals_created ?? 0} dropped=${JSON.stringify(r.filtered_by ?? {})} by_q=${JSON.stringify(r.per_question ?? {})}`);
  }

  const sigs = (await sb.from('signals').select('id, entity_id, structured_tags')
    .eq('workspace_id', WS).eq('type', 'research_result').gte('created_at', startedAt).limit(500)).data ?? [];
  for (const s of sigs as any[]) newSignals.push(s.id);
  console.log(`\nnew signals created: ${newSignals.length}`);

  console.log('\n=== ENRICH ===');
  const sub = (await sb.from('subscriptions').select('id, owner_id')
    .eq('workspace_id', WS).eq('agent_behavior', 'enricher').eq('active', true)
    .order('created_at', { ascending: true }).limit(1).maybeSingle()).data as any;
  if (!sub) { console.log('no active enricher subscription'); return; }

  for (const s of sigs as any[]) {
    const r: any = await runAgent(sb, { workspace_id: WS, agent: sub.owner_id, subscription_id: sub.id, signal_id: s.id, entity_id: s.entity_id });
    console.log(`  ${String(s.structured_tags?.answers_question ?? '-').padEnd(22)} ok=${r.ok} action=${r.action ?? '-'} facts=${r.facts_asserted ?? 0}  ${String(s.structured_tags?.url ?? '').slice(0, 70)}`);
  }

  console.log('\n=== FACTS WRITTEN THIS RUN, by brief question ===');
  // Scope to facts from THIS run's pages. Reading everything the workspace wrote
  // since the start time sweeps in the deployed Inngest worker doing its own
  // enrichment on older pages, which is not what this is measuring.
  const runSigIds = (sigs as any[]).map((s) => s.id);
  let facts: any[] = [];
  for (let i = 0; i < runSigIds.length; i += 200) {
    const r = await sb.from('facts').select('predicate, object_text, subject_entity, signal_id')
      .in('signal_id', runSigIds.slice(i, i + 200)).limit(1000);
    facts = facts.concat(r.data ?? []);
  }
  const qBySig = new Map((sigs as any[]).map((s) => [s.id, s.structured_tags?.answers_question]));
  const names = new Map<string, string>();
  for (const p of picked) names.set(p.id, p.name);
  const bySlot = new Map<string, any[]>();
  let system = 0;
  for (const f of facts as any[]) {
    if (/^score_|_breakdown$|^icp_fit$|^outreach_|^contact_/.test(f.predicate)) { system++; continue; }
    const q = qBySig.get(f.signal_id);
    const key = q && brief.some((bq) => bq.id === q) ? q : '(no question on the page)';
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key)!.push(f);
  }
  const real = [...bySlot.values()].reduce((n, a) => n + a.length, 0);
  for (const q of brief) {
    const fs = bySlot.get(q.id) ?? [];
    console.log(`\n  [${q.id}] ${fs.length}`);
    for (const f of fs.slice(0, 10)) console.log(`      · ${names.get(f.subject_entity) ?? '?'} | ${f.predicate} = ${String(f.object_text ?? '').slice(0, 88)}`);
  }
  const off = bySlot.get('(no question on the page)') ?? [];
  console.log(`\n  (no question on the page) ${off.length}`);
  for (const f of off.slice(0, 15)) console.log(`      · ${names.get(f.subject_entity) ?? '?'} | ${f.predicate} = ${String(f.object_text ?? '').slice(0, 88)}`);

  console.log(`\nTOTAL: ${real} content facts (${system} system/scoring facts ignored) from ${newSignals.length} pages across ${picked.length} accounts`);
  console.log(`  facts per page: ${newSignals.length ? (real / newSignals.length).toFixed(1) : '-'}`);
  console.log(`  from a page with a question: ${real ? (((real - off.length) / real) * 100).toFixed(0) : '-'}%`);
})();
