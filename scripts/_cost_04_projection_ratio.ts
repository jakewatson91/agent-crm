/**
 * Is the "token-efficient projection" claim true, and by how much?
 *
 * reads.ts:5 says the projections are "summaries and counts, not raw row dumps".
 * That is the technical differentiator against pointing a general assistant at a
 * CRM's API, and it had never been measured.
 *
 * THE BASELINE HAS TO BE FAIR OR THE NUMBER IS WORTHLESS. Two traps, both hit on
 * the first attempt here:
 *   - `select('*')` on signals pulls `embedding`, 19,189 chars of serialized
 *     pgvector per row. No wrapper would put that in a prompt. Excluded.
 *   - facts key on `subject_entity`, not `entity_id`. Getting that wrong returns
 *     zero facts and the whole comparison becomes signals-only.
 *
 * So the baseline is: entity attributes + CURRENT facts (predicate/value/date,
 * no content hashes or internal ids) + recent signals with their text. That is
 * what an honest MCP tool over these tables hands an agent that has been asked to
 * write to an account.
 *
 * Tokens are chars/4, the heuristic compress.ts uses.
 *
 * Reads only. No LLM.
 *
 * Usage: pnpm tsx scripts/_cost_04_projection_ratio.ts [--n 20]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { getEntity, listEntities, currentFactRows } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';
const argv = process.argv.slice(2);
let N = 20;
for (let i = 0; i < argv.length; i++) if (argv[i] === '--n') N = Number(argv[++i]) || N;

const tok = (v: unknown) => Math.ceil(JSON.stringify(v ?? null).length / 4);
const SIGNAL_COLS = 'id, type, magnitude, observed_at, structured_tags, body_for_embedding';

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

  console.log(`the ${sample.length} fact-heaviest accounts of ${scored.length} checked\n`);
  console.log(`${'account'.padEnd(24)}${'facts'.padStart(7)}${'sigs'.padStart(6)}${'projection'.padStart(12)}${'fair raw'.padStart(10)}${'ratio'.padStart(8)}`);
  console.log('-'.repeat(67));

  let sumProj = 0, sumRaw = 0;
  for (const e of sample) {
    const proj = await getEntity(sb as any, WS, e.id);
    const { data: allFacts } = await sb.from('facts').select('*')
      .eq('workspace_id', WS).eq('subject_entity', e.id).limit(3000);
    const current = [...currentFactRows((allFacts ?? []) as any[], (f: any) => f.predicate).values()];
    const { data: sigs } = await sb.from('signals').select(SIGNAL_COLS)
      .eq('workspace_id', WS).eq('entity_id', e.id).order('observed_at', { ascending: false }).limit(50);

    // Fair dump: what the agent would need, without internal plumbing.
    const rawDump = {
      entity: { id: e.id, name: e.name, attributes: e.attributes },
      facts: (current as any[]).map((f) => ({ predicate: f.predicate, value: f.object_text, confidence: f.confidence, observed_at: f.observed_at })),
      signals: (sigs ?? []).map((s: any) => ({ type: s.type, magnitude: s.magnitude, observed_at: s.observed_at, tags: s.structured_tags, text: s.body_for_embedding })),
    };

    const p = tok(proj), r = tok(rawDump);
    sumProj += p; sumRaw += r;
    console.log(`${e.name.slice(0, 23).padEnd(24)}${String(e.facts).padStart(7)}${String((sigs ?? []).length).padStart(6)}${p.toLocaleString().padStart(12)}${r.toLocaleString().padStart(10)}${`${(r / (p || 1)).toFixed(1)}x`.padStart(8)}`);
  }

  console.log('-'.repeat(67));
  const ratio = sumRaw / (sumProj || 1);
  console.log(`${'TOTAL'.padEnd(37)}${sumProj.toLocaleString().padStart(12)}${sumRaw.toLocaleString().padStart(10)}${`${ratio.toFixed(1)}x`.padStart(8)}`);

  const book = await listEntities(sb as any, WS, { limit: 50 } as any);
  const { data: bookRaw } = await sb.from('entities').select('id, name, attributes')
    .eq('workspace_id', WS).is('archived_at', null).limit(50);
  console.log(`\nbook read, 50 accounts:`);
  console.log(`  listEntities projection   ${tok(book).toLocaleString().padStart(9)} tokens`);
  console.log(`  raw entity rows           ${tok(bookRaw ?? []).toLocaleString().padStart(9)} tokens   ${(tok(bookRaw ?? []) / (tok(book) || 1)).toFixed(1)}x`);

  const avgSaved = (sumRaw - sumProj) / (sample.length || 1);
  console.log(`\nper account read into context:`);
  console.log(`  projected  ~${Math.round(sumProj / sample.length).toLocaleString()} tokens`);
  console.log(`  fair raw   ~${Math.round(sumRaw / sample.length).toLocaleString()} tokens`);
  console.log(`  saved      ~${Math.round(avgSaved).toLocaleString()} tokens = $${(avgSaved / 1e6 * 0.14).toFixed(5)} at flash input, $${(avgSaved / 1e6 * 3).toFixed(4)} at a frontier model's ~$3/1M`);
})();
