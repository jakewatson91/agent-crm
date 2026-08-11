/**
 * Confirm the one-line diagnosis before changing anything.
 *
 * entity_research_dispatcher.ts:438 backs an account off only when
 * signal_strength < 0.5. "Hot" is partly DEFINED by strong signal, so the
 * heaviest-researched accounts are exactly the ones that can never back off.
 * They keep their 24h cadence while the 30-day cross-run dedup drains the fresh
 * material, which is why yield collapses to 0.22 by the 10th visit.
 *
 * If that is right, the top-spending accounts should show: high signal_strength,
 * and recent runs keeping ~nothing. Then the fix is to back off on RECENT YIELD
 * instead of on signal strength — same mechanism, different input.
 *
 * Reads only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { currentFactRows } from '@agent-crm/tools';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0;
  for (;;) {
    const { data, error } = await build(f, f + 999);
    if (error) throw error;
    if (!data?.length) break;
    out = out.concat(data);
    if (data.length < 1000) break;
    f += 1000;
  }
  return out;
}

(async () => {
  const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  const runs = await pageAll<any>((f, t) => sb.from('events')
    .select('target_id, created_at, payload').eq('workspace_id', WS)
    .eq('action', 'research_completed').gte('created_at', since)
    .order('created_at', { ascending: true }).range(f, t));

  const per = new Map<string, { runs: number; searches: number; kept: number[] }>();
  for (const r of runs) {
    if (!r.target_id) continue;
    const a = per.get(r.target_id) ?? { runs: 0, searches: 0, kept: [] };
    a.runs++; a.searches += r.payload?.searches ?? 0;
    a.kept.push(r.payload?.results_created ?? 0);
    per.set(r.target_id, a);
  }
  const top = [...per.entries()].sort((a, b) => b[1].searches - a[1].searches).slice(0, 12);
  const ids = top.map(([id]) => id);

  // Current signal_strength for those accounts (supersede-aware).
  const factRows = await pageAll<any>((f, t) => sb.from('facts')
    .select('id, subject_entity, predicate, object_text, observed_at, supersedes')
    .eq('workspace_id', WS).eq('predicate', 'score_signal_strength')
    .in('subject_entity', ids).range(f, t));
  const bySubject = new Map<string, any[]>();
  for (const r of factRows) {
    bySubject.set(r.subject_entity, [...(bySubject.get(r.subject_entity) ?? []), r]);
  }
  const sigOf = new Map<string, number>();
  for (const [id, rows] of bySubject) {
    const cur = [...currentFactRows(rows, () => 'score_signal_strength').values()][0];
    sigOf.set(id, Number(cur?.object_text ?? 0));
  }

  const names = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 100) {
    const { data } = await sb.from('entities').select('id, name').in('id', ids.slice(i, i + 100));
    for (const e of (data ?? []) as any[]) names.set(e.id, e.name);
  }

  console.log(`\nthe 12 accounts eating the search budget:\n`);
  console.log(`  ${'account'.padEnd(24)}${'runs'.padStart(6)}${'searches'.padStart(10)}${'signal'.padStart(8)}${'backs off?'.padStart(12)}   last 5 runs kept`);
  let barrenButExempt = 0;
  for (const [id, v] of top) {
    const sig = sigOf.get(id) ?? 0;
    const backsOff = sig < 0.5;
    const last5 = v.kept.slice(-5);
    const barren = last5.reduce((a, b) => a + b, 0) === 0;
    if (barren && !backsOff) barrenButExempt++;
    console.log(`  ${(names.get(id) ?? id.slice(0, 8)).slice(0, 23).padEnd(24)}${String(v.runs).padStart(6)}${String(v.searches).padStart(10)}${sig.toFixed(2).padStart(8)}${(backsOff ? 'yes' : 'NO').padStart(12)}   [${last5.join(', ')}]`);
  }

  const exempt = top.filter(([id]) => (sigOf.get(id) ?? 0) >= 0.5).length;
  console.log(`\n  ${exempt} of ${top.length} are exempt from backoff because their signal is strong.`);
  console.log(`  ${barrenButExempt} of those kept NOTHING in their last 5 runs and still get researched every 24h.`);
  console.log(`\n  VERDICT: ${exempt >= top.length * 0.6
    ? 'confirmed — the heaviest spenders are exempt from the very mechanism meant to stop this.\n           Backing off on RECENT YIELD instead of signal strength fixes it in one line.'
    : 'not confirmed — signal strength is not what is keeping these accounts on a fast cadence.'}`);
})();
