/**
 * The honest comparison: tokens to COMPLETE A TASK, not tokens in one response.
 *
 * _cost_04 measured one projection against one hand-shaped dump and found 1.0x.
 * That baseline was rigged in the naive agent's favour — it was handed current
 * facts only, a 50-signal cap, no embeddings and no internal ids. A general agent
 * pointed at a CRM API gets none of that. It gets tables.
 *
 * Three things it has to pay for that the projection absorbs:
 *
 *   1. SUPERSEDE HISTORY. Facts are event-sourced: a rescore writes a NEW row
 *      carrying supersedes=<old id>. The current row is the one no other row
 *      points at. An agent that does not know this pulls every version. An agent
 *      that guesses `supersedes is null` gets the OLDEST value — a bug that
 *      shipped three separate times inside this repo, written by people who own
 *      the schema.
 *   2. ROUND TRIPS. It cannot ask for "the account" — it discovers tables, then
 *      queries each, then filters. Every turn re-sends the whole accumulated
 *      conversation, so cost grows with the SQUARE of the turns, not linearly.
 *   3. NO IDEA WHAT MATTERS. It has no fact scoring, so it cannot take the top 8
 *      of 300 facts. It takes all of them or an arbitrary slice.
 *
 * Reads only. No LLM.
 *
 * Usage: pnpm tsx scripts/_cost_06_task_level.ts [--n 15]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getEntity, currentFactRows } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const argv = process.argv.slice(2);
let N = 15;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--n') N = Number(argv[++i]) || N;

const tok = (v: unknown) => Math.ceil(JSON.stringify(v ?? null).length / 4);

/**
 * Input tokens billed across a multi-turn tool loop. Each turn re-sends the
 * system prompt plus everything returned so far, which is why turn count is
 * expensive and not merely slow.
 */
function billedAcrossTurns(system: number, toolResults: number[]): number {
  let billed = 0, carried = system;
  for (const r of toolResults) {
    billed += carried;   // this turn's input
    carried += r;        // the result joins the history for every later turn
  }
  return billed + carried; // final turn that produces the answer
}

(async () => {
  const { data: ents } = await sb.from('entities').select('id, name, attributes')
    .eq('workspace_id', WS).is('archived_at', null).limit(300);
  const candidates = (ents ?? []) as Array<{ id: string; name: string; attributes: unknown }>;

  const scored: Array<{ id: string; name: string; attributes: unknown; facts: number }> = [];
  for (const e of candidates.slice(0, 150)) {
    const { count } = await sb.from('facts').select('id', { count: 'exact', head: true })
      .eq('workspace_id', WS).eq('subject_entity', e.id);
    scored.push({ ...e, facts: count ?? 0 });
  }
  scored.sort((a, b) => b.facts - a.facts);
  const sample = scored.slice(0, N).filter((e) => e.facts > 0);

  const SYSTEM = 600; // comparable system prompt either way

  console.log(`\ntask: "decide whether to write to this account, and on what anchor"\n`);
  console.log(`${'account'.padEnd(22)}${'all facts'.padStart(10)}${'current'.padStart(9)}${'dead'.padStart(7)}${'ours'.padStart(9)}${'generic'.padStart(10)}${'ratio'.padStart(8)}`);
  console.log('-'.repeat(75));

  let sumOurs = 0, sumGeneric = 0, sumAll = 0, sumCurrent = 0, sumOneOurs = 0, sumOneGeneric = 0;
  for (const e of sample) {
    const { data: allFactsRaw } = await sb.from('facts').select('*')
      .eq('workspace_id', WS).eq('subject_entity', e.id).limit(4000);
    const allFacts = (allFactsRaw ?? []) as any[];
    const current = [...currentFactRows(allFacts, (f: any) => f.predicate).values()];
    const { data: sigs } = await sb.from('signals')
      .select('id, type, magnitude, observed_at, structured_tags, body_for_embedding')
      .eq('workspace_id', WS).eq('entity_id', e.id).limit(200);

    // OURS: one call, one shaped answer.
    const ours = billedAcrossTurns(SYSTEM, [tok(await getEntity(sb as any, WS, e.id))]);

    // GENERIC: schema peek, then entity, then ALL fact versions, then signals,
    // then a filtering turn. Nothing here is unfair — it is what you do when the
    // tool is "run a query" instead of "give me the account".
    const generic = billedAcrossTurns(SYSTEM, [
      120,                                   // list tables / describe schema
      tok({ id: e.id, name: e.name, attributes: e.attributes }),
      tok(allFacts.map((f: any) => ({ predicate: f.predicate, object_text: f.object_text, observed_at: f.observed_at, supersedes: f.supersedes, id: f.id, confidence: f.confidence }))),
      tok((sigs ?? []).map((s: any) => ({ type: s.type, observed_at: s.observed_at, tags: s.structured_tags, text: s.body_for_embedding }))),
    ]);

    // Same 20-signal window getEntity uses (reads.ts:313), so the signal side is
    // matched and the only difference left is fact versions. This isolates the
    // MEASURED part from the modeled round-trip part.
    const sig20 = (sigs ?? []).slice(0, 20);
    const oneShotOurs = SYSTEM + tok(await getEntity(sb as any, WS, e.id));
    const oneShotGeneric = SYSTEM + tok({
      entity: { id: e.id, name: e.name, attributes: e.attributes },
      facts: allFacts.map((f: any) => ({ predicate: f.predicate, object_text: f.object_text, observed_at: f.observed_at, supersedes: f.supersedes, id: f.id, confidence: f.confidence })),
      signals: sig20.map((s: any) => ({ type: s.type, observed_at: s.observed_at, tags: s.structured_tags, text: s.body_for_embedding })),
    });
    sumOneOurs += oneShotOurs; sumOneGeneric += oneShotGeneric;

    sumOurs += ours; sumGeneric += generic; sumAll += allFacts.length; sumCurrent += current.length;
    console.log(`${e.name.slice(0, 21).padEnd(22)}${String(allFacts.length).padStart(10)}${String(current.length).padStart(9)}${String(allFacts.length - current.length).padStart(7)}${ours.toLocaleString().padStart(9)}${generic.toLocaleString().padStart(10)}${`${(generic / (ours || 1)).toFixed(1)}x`.padStart(8)}`);
  }

  console.log('-'.repeat(75));
  console.log(`${'TOTAL'.padEnd(22)}${String(sumAll).padStart(10)}${String(sumCurrent).padStart(9)}${String(sumAll - sumCurrent).padStart(7)}${sumOurs.toLocaleString().padStart(9)}${sumGeneric.toLocaleString().padStart(10)}${`${(sumGeneric / (sumOurs || 1)).toFixed(1)}x`.padStart(8)}`);

  console.log(`\nMEASURED — same one call each, same 20-signal window, only fact versions differ:`);
  console.log(`  ours ${sumOneOurs.toLocaleString()} vs generic ${sumOneGeneric.toLocaleString()} = ${(sumOneGeneric / (sumOneOurs || 1)).toFixed(1)}x`);
  console.log(`  this part assumes nothing about how the other agent is built.`);

  console.log(`\nMODELED — adding 5 round trips with context carried forward:`);
  console.log(`  ours ${sumOurs.toLocaleString()} vs generic ${sumGeneric.toLocaleString()} = ${(sumGeneric / (sumOurs || 1)).toFixed(1)}x`);
  console.log(`  the turn count is my assumption. A competitor who builds one get_account tool erases this half.`);

  console.log(`\nwhere the difference comes from:`);
  console.log(`  supersede history      ${sumAll} fact rows exist, ${sumCurrent} are current — ${(sumAll / (sumCurrent || 1)).toFixed(1)}x more rows than answers`);
  console.log(`  round trips            1 call vs 5, and every turn re-sends the ones before it`);
  console.log(`  per account, per task  ${Math.round(sumOurs / sample.length).toLocaleString()} vs ${Math.round(sumGeneric / sample.length).toLocaleString()} input tokens`);

  const savedPerTask = (sumGeneric - sumOurs) / sample.length;
  console.log(`\n  at a frontier model's ~$3/1M input, that is $${(savedPerTask / 1e6 * 3).toFixed(4)} per account looked at.`);
  console.log(`  over a 1,163-account book, once each: $${(savedPerTask * 1163 / 1e6 * 3).toFixed(2)} vs $${(sumOurs / sample.length * 1163 / 1e6 * 3).toFixed(2)}`);
})();
