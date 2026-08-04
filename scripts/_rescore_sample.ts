/**
 * Sample rescore: score the top N accounts by current score and report what the
 * out-of-scope veto does to them. Writes scores (via scoreAndAssert) exactly as
 * the full rescore would — this is a real slice of the run, not a simulation, so
 * the numbers below are what the full pass will do.
 *
 * Usage: tsx scripts/_rescore_sample.ts [n]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const N = Number(process.argv[2] ?? 25);

async function main() {
  const scoreRows: Array<{ id: string; subject_entity: string; object_text: string; supersedes: string | null }> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await sb.from('facts').select('id, subject_entity, object_text, supersedes')
      .eq('workspace_id', WS).eq('predicate', 'score_total').order('id').range(from, from + 999);
    const page = (data ?? []) as typeof scoreRows;
    scoreRows.push(...page);
    if (page.length < 1000) break;
  }
  const superseded = new Set(scoreRows.map((r) => r.supersedes).filter(Boolean));
  const ranked = scoreRows.filter((r) => !superseded.has(r.id))
    .map((r) => ({ entity_id: r.subject_entity, before: parseFloat(r.object_text ?? '') }))
    .filter((r) => Number.isFinite(r.before))
    .sort((a, b) => b.before - a.before)
    .slice(0, N);

  const names = new Map<string, string>();
  for (let i = 0; i < ranked.length; i += 200) {
    const { data } = await sb.from('entities').select('id, name').in('id', ranked.slice(i, i + 200).map((r) => r.entity_id));
    for (const e of (data ?? []) as Array<{ id: string; name: string }>) names.set(e.id, e.name);
  }

  const actor = { workspace_id: WS, actor_kind: 'system' as const, actor_id: 'rescore_sample' };
  const t0 = Date.now();
  let vetoed = 0, llmCalls = 0;
  console.log(`rescoring top ${ranked.length} accounts by current score…\n`);
  for (const r of ranked) {
    const name = names.get(r.entity_id) ?? r.entity_id.slice(0, 8);
    try {
      const s = await scoreAndAssert(sb, actor, r.entity_id);
      if (!s) { console.log(`  ${name.padEnd(34)} skipped`); continue; }
      if (s.llm_called) llmCalls++;
      const veto = s.breakdown.out_of_scope;
      if (veto) vetoed++;
      const delta = (s.icp_total - r.before);
      console.log(`  ${name.padEnd(34)} ${r.before.toFixed(2)} -> ${s.icp_total.toFixed(2)} ${delta <= -0.2 ? '⬇' : delta >= 0.2 ? '⬆' : ' '}${veto ? `  VETO: ${veto.slice(0, 110)}` : ''}`);
    } catch (e) {
      console.log(`  ${name.padEnd(34)} ERROR ${(e as Error).message.slice(0, 80)}`);
    }
  }
  const secs = (Date.now() - t0) / 1000;
  console.log(`\n${ranked.length} accounts in ${secs.toFixed(0)}s (${(secs / ranked.length).toFixed(1)}s each, ${llmCalls} LLM calls)`);
  console.log(`${vetoed} vetoed out of scope (${((vetoed / ranked.length) * 100).toFixed(0)}%)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
