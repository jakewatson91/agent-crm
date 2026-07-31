/**
 * One-time backfill for the candidate-promotion bug: resolveOrCreateEntity created
 * accounts as `_candidate: true`, the enricher piled facts into them, but scoreEntity
 * refused to score candidates and no promotion step existed — so they accumulated
 * evidence the scorer ignored forever (the score_signal_coupling sweep RED).
 *
 * This promotes every candidate that has >= 1 substantive fact (clears _candidate)
 * and runs scoreAndAssert so it gets a real score. Thin candidates with no
 * substantive facts are left as candidates (correct — nothing to score yet).
 *
 * Additive + reversible. Run: DOTENV_CONFIG_PATH=.env.local tsx -r dotenv/config scripts/backfill_promote_candidates.ts [--apply]
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { scoreAndAssert, isSubstantiveFact, chunk } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = process.env.WS_ID || 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const APPLY = process.argv.includes('--apply');

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const size = 1000;
  for (;;) { const { data, error } = await q(f, f + size - 1); if (error) throw error; const rows = (data ?? []) as T[]; out.push(...rows); if (rows.length < size) break; f += size; }
  return out;
}

async function main() {
  const ents = await fetchAll<{ id: string; name: string; attributes: any }>((f, t) => sb.from('entities')
    .select('id, name, attributes').eq('workspace_id', ws).order('id').range(f, t));
  const candidates = ents.filter((e) => e.attributes?._candidate === true);
  console.log(`total entities=${ents.length}  candidates=${candidates.length}`);

  // Which candidates have >= 1 substantive fact? Bulk-fetch active facts in id chunks.
  const candIds = candidates.map((c) => c.id);
  const substantiveByEnt = new Map<string, number>();
  for (const ids of chunk(candIds, 300)) {
    const facts = await fetchAll<{ subject_entity: string; predicate: string }>((f, t) => sb.from('facts')
      .select('subject_entity, predicate').eq('workspace_id', ws).is('supersedes', null)
      .in('subject_entity', ids).order('id').range(f, t));
    for (const fct of facts) {
      if (isSubstantiveFact(fct.predicate)) substantiveByEnt.set(fct.subject_entity, (substantiveByEnt.get(fct.subject_entity) ?? 0) + 1);
    }
  }
  const promotable = candidates.filter((c) => (substantiveByEnt.get(c.id) ?? 0) >= 1);
  console.log(`candidates with >= 1 substantive fact (promotable) = ${promotable.length}`);
  console.log(`candidates left as-is (no substantive facts) = ${candidates.length - promotable.length}`);
  for (const c of promotable.slice(0, 10)) console.log(`  - ${c.name} (${c.id.slice(0, 8)})  substantive_facts=${substantiveByEnt.get(c.id)}`);

  if (!APPLY) { console.log('\nDRY RUN. Re-run with --apply to promote + score.'); return; }

  const actor = { workspace_id: ws, actor_kind: 'system' as const, actor_id: 'backfill-promote' };
  let promoted = 0, scored = 0, nullScore = 0, errs = 0;
  for (const batch of chunk(promotable, 5)) {
    await Promise.all(batch.map(async (c) => {
      try {
        await sb.from('entities').update({ attributes: { ...c.attributes, _candidate: false } }).eq('id', c.id);
        promoted += 1;
        const s = await scoreAndAssert(sb, actor, c.id);
        if (s) scored += 1; else nullScore += 1;
      } catch (e) { errs += 1; console.error(`  ! ${c.name} (${c.id.slice(0, 8)}): ${(e as Error)?.message ?? e}`); }
    }));
    process.stdout.write(`\r  promoted=${promoted} scored=${scored} null=${nullScore} err=${errs} / ${promotable.length}`);
  }
  console.log(`\nDONE. promoted=${promoted} scored=${scored} null_score=${nullScore} errors=${errs}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
