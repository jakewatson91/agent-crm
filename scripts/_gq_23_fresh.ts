/**
 * Verify flat fact names end to end on accounts that have NEVER been researched,
 * so the 30-day cross-run dedup has not already taken their good pages.
 * SPENDS EXA: 5 searches per account.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createServerClient } from '@agent-crm/db';
import { getPolicy, resolveBrief } from '@agent-crm/tools';
import { runEntityResearch } from '../inngest/functions/research.ts';
import { runAgent } from '../inngest/functions/agent_logic.ts';

const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const N = Number(process.argv[2] ?? 3);

(async () => {
  const sb = createServerClient();
  const brief = resolveBrief(await getPolicy(sb as any, WS));

  const researched = new Set<string>();
  for (const a of ['research_completed', 'research_triggered']) {
    const ev = (await sb.from('events').select('target_id').eq('workspace_id', WS).eq('action', a).limit(5000)).data ?? [];
    for (const e of ev as any[]) researched.add(e.target_id);
  }
  const fits = (await sb.from('facts').select('subject_entity, object_text')
    .eq('workspace_id', WS).eq('predicate', 'icp_fit').limit(2000)).data ?? [];
  const ranked = (fits as any[]).map((r) => ({ id: r.subject_entity, fit: Number(r.object_text) }))
    .filter((r) => Number.isFinite(r.fit) && !researched.has(r.id)).sort((a, b) => b.fit - a.fit);

  const picked: Array<{ id: string; name: string }> = [];
  for (const r of ranked) {
    if (picked.length >= N) break;
    const e = (await sb.from('entities').select('id, name, attributes').eq('id', r.id).maybeSingle()).data as any;
    if (!e?.attributes?.domain) continue;
    picked.push({ id: e.id, name: e.name });
  }
  console.log(`never-researched accounts picked: ${picked.map((p) => p.name).join(', ')}\n`);

  const startedAt = new Date().toISOString();
  for (const p of picked) {
    const r: any = await runEntityResearch(sb, { workspace_id: WS, entity_id: p.id, entity_name: p.name, reason: 'manual:_gq_23', angle_count: 5, kind: 'account' } as any);
    console.log(`  ${p.name.padEnd(22)} searches=${r.searches} kept=${r.signals_created} fetched=${JSON.stringify(r.per_angle_fetched ?? {})}`);
  }

  const sigs = (await sb.from('signals').select('id, entity_id, structured_tags')
    .eq('workspace_id', WS).eq('type', 'research_result').gte('created_at', startedAt).limit(200)).data ?? [];
  const sub = (await sb.from('subscriptions').select('id, owner_id').eq('workspace_id', WS)
    .eq('agent_behavior', 'enricher').eq('active', true).order('created_at', { ascending: true }).limit(1).maybeSingle()).data as any;
  console.log(`\nenriching ${sigs.length} new pages...`);
  for (const s of sigs as any[]) {
    const r: any = await runAgent(sb, { workspace_id: WS, agent: sub.owner_id, subscription_id: sub.id, signal_id: s.id, entity_id: s.entity_id });
    console.log(`  q=${String(s.structured_tags?.answers_question ?? '-').padEnd(20)} facts=${r.facts_asserted ?? 0}`);
  }

  const ids = (sigs as any[]).map((s) => s.id);
  let facts: any[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await sb.from('facts').select('predicate, object_text, signal_id').in('signal_id', ids.slice(i, i + 200)).limit(1000);
    facts = facts.concat(r.data ?? []);
  }
  const qBySig = new Map((sigs as any[]).map((s) => [s.id, s.structured_tags?.answers_question]));
  console.log(`\nfacts from those pages: ${facts.length}`);
  const dotted = facts.filter((f) => /\./.test(f.predicate));
  for (const f of facts.slice(0, 25)) console.log(`  [${qBySig.get(f.signal_id) ?? '-'}] ${f.predicate} = ${String(f.object_text ?? '').slice(0, 80)}`);
  console.log(`\nfact names containing a dot (old naming scheme): ${dotted.length}`);
  console.log(dotted.length === 0 ? 'FLAT NAMES CONFIRMED' : `STILL DOTTED: ${dotted.map((f) => f.predicate).join(', ')}`);
})();
