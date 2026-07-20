import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const ws = 'af602fa1-1e0b-4bee-9841-01894553e0a9';
const now = Date.now();
const DAY = 86_400_000;
const since24 = new Date(now - DAY).toISOString();
const since7d = new Date(now - 7 * DAY).toISOString();

async function fetchAll<T>(q: (f: number, t: number) => any): Promise<T[]> {
  const out: T[] = []; let f = 0; const size = 1000;
  for (;;) { const { data, error } = await q(f, f + size - 1); if (error) throw error; const rows = (data ?? []) as T[]; out.push(...rows); if (rows.length < size) break; f += size; }
  return out;
}

async function main() {
  // ---------- COST_PER_UNIQUE_SIGNAL ----------
  console.log('=== cost_per_unique_signal ===');
  const metrics = (await fetchAll<{ payload: any; created_at: string }>((f, t) => sb.from('events')
    .select('payload, created_at').eq('workspace_id', ws).eq('action', 'agent_run_metrics')
    .gte('created_at', since7d).order('created_at', { ascending: false }).range(f, t)))
    .filter((e) => e.payload != null);

  // tokens in last 24h, broken down by behavior
  const tok24ByBehavior = new Map<string, { tok: number; runs: number }>();
  let tok24 = 0;
  for (const e of metrics) {
    const age = now - new Date(e.created_at).getTime();
    if (age > DAY) continue;
    const t = (e.payload?.input_tokens ?? 0) + (e.payload?.output_tokens ?? 0);
    const b = e.payload?.behavior ?? '(unknown)';
    const rec = tok24ByBehavior.get(b) ?? { tok: 0, runs: 0 };
    rec.tok += t; rec.runs += 1; tok24ByBehavior.set(b, rec);
    tok24 += t;
  }
  console.log(`tokens_24h total = ${tok24}`);
  console.log('  by behavior:');
  for (const [b, r] of [...tok24ByBehavior].sort((a, c) => c[1].tok - a[1].tok)) {
    console.log(`    ${b.padEnd(20)} ${r.tok.toString().padStart(9)} tok  (${r.runs} runs, ${(r.tok / Math.max(1, r.runs)).toFixed(0)} tok/run)`);
  }

  // unique signals 24h
  const sig24 = await fetchAll<{ body_hash: string | null; structured_tags: any }>((f, t) => sb.from('signals')
    .select('body_hash, structured_tags').eq('workspace_id', ws).gte('created_at', since24)
    .order('created_at', { ascending: false }).range(f, t));
  const uniq24 = new Set(sig24.filter((s) => s.body_hash).map((s) => s.body_hash));
  console.log(`unique_signals_24h = ${uniq24.size} (of ${sig24.length} raw)`);
  console.log(`cost_per_unique_signal = ${(tok24 / Math.max(1, uniq24.size)).toFixed(0)} tok/sig`);

  // what if we exclude qualification-loop-ish behaviors from the numerator?
  const loopish = [...tok24ByBehavior].filter(([b]) => /qualif|runner|loop|research/i.test(b));
  const loopTok = loopish.reduce((a, [, r]) => a + r.tok, 0);
  if (loopTok > 0) {
    console.log(`  >> excluding loop behaviors (${loopish.map((l) => l[0]).join(',')}): ${((tok24 - loopTok) / Math.max(1, uniq24.size)).toFixed(0)} tok/sig`);
  }

  // ---------- SCORE_SIGNAL_COUPLING ----------
  console.log('\n=== score_signal_coupling ===');
  const cutoff = since24;
  const dispatches = await fetchAll<{ target_id: string | null; payload: any }>((f, t) => sb.from('events')
    .select('target_id, payload').eq('workspace_id', ws).eq('action', 'agent_dispatch_result')
    .gte('created_at', cutoff).order('id').range(f, t));
  const entitiesWithNewFacts = new Set<string>();
  for (const d of dispatches) if ((d.payload?.facts_asserted ?? 0) > 0 && d.target_id) entitiesWithNewFacts.add(d.target_id);
  console.log(`entities_with_new_facts_24h = ${entitiesWithNewFacts.size}`);

  // classify those entities: account vs contact vs other
  const ids = [...entitiesWithNewFacts];
  const ents = await fetchAll<Record<string, any>>((f, t) => sb.from('entities')
    .select('*').in('id', ids).order('id').range(f, t));
  if (ents[0]) console.log('  (entities columns:', Object.keys(ents[0]).join(','), ')');
  const kindField = ents[0] && ('kind' in ents[0] ? 'kind' : 'type' in ents[0] ? 'type' : 'entity_type' in ents[0] ? 'entity_type' : 'id');
  const kindOf = new Map(ents.map((e) => [e.id as string, String(e[kindField as string])]));
  const byKind = new Map<string, number>();
  for (const id of ids) { const k = kindOf.get(id) ?? '(missing)'; byKind.set(k, (byKind.get(k) ?? 0) + 1); }
  console.log('  by entity kind:', JSON.stringify(Object.fromEntries(byKind)));

  // current icp_fit fact per entity (account scoring)
  const icp = await fetchAll<{ subject_entity: string; observed_at: string; object_text: string | null }>((f, t) => sb.from('facts')
    .select('subject_entity, observed_at, object_text').eq('workspace_id', ws).eq('predicate', 'icp_fit')
    .is('supersedes', null).in('subject_entity', ids).order('id').range(f, t));
  const icpObs = new Map(icp.map((r) => [r.subject_entity, r.observed_at]));

  let moved = 0, accountsNoIcp = 0, accountsStale = 0;
  const staleSample: string[] = [];
  for (const id of ids) {
    const k = kindOf.get(id);
    const obs = icpObs.get(id);
    if (obs && obs >= cutoff) { moved += 1; continue; }
    if (k === 'account' || k === 'company') {
      if (!obs) accountsNoIcp += 1;
      else { accountsStale += 1; if (staleSample.length < 8) staleSample.push(`${id.slice(0, 8)} icp_obs=${obs.slice(0, 16)}`); }
    }
  }
  console.log(`moved (rescored in 24h) = ${moved}/${entitiesWithNewFacts.size} (${(100 * moved / Math.max(1, entitiesWithNewFacts.size)).toFixed(0)}%)`);
  console.log(`  accounts with NO icp_fit fact at all   = ${accountsNoIcp}`);
  console.log(`  accounts with STALE icp_fit (>24h old) = ${accountsStale}`);
  console.log('  stale sample:'); for (const s of staleSample) console.log('    ', s);

  // how many of the "new fact" dispatches were SUBSTANTIVE (account-relevant) vs contact/admin?
  console.log('\n  dispatch facts_asserted breakdown (first 12):');
  let shown = 0;
  for (const d of dispatches) {
    if ((d.payload?.facts_asserted ?? 0) > 0 && d.target_id && shown < 12) {
      console.log(`    ent=${d.target_id.slice(0, 8)} kind=${kindOf.get(d.target_id) ?? '?'} facts=${d.payload.facts_asserted} behavior=${d.payload?.behavior ?? '?'}`);
      shown += 1;
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
