/**
 * How badly does the research dispatcher mis-tier accounts?
 *
 * entity_research_dispatcher.ts:265 reads icp_fit / score_total /
 * score_signal_strength / dropped_until with `.is('supersedes', null)`. A
 * rescore writes the NEW row carrying supersedes=<old id>, so the row with a
 * null supersedes is the FIRST-EVER score and its value never moves. reads.ts
 * and system_tasks.ts already carry comments about this exact trap; the
 * dispatcher was not updated.
 *
 * This compares the score the dispatcher reads against the current one and
 * counts how many accounts land in a different research tier as a result.
 * Read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const WS = process.env.GQ_WS ?? 'e7052848-2270-41ac-90b6-d9b75c87f6d3';

// Same thresholds as the dispatcher.
const HOT = 0.5, COLD = 0.3;
const tier = (s: number) => (s >= HOT ? 'hot' : s < COLD ? 'cold' : 'default');
const CADENCE = { hot: '24h', default: '7d', cold: '30d' } as const;

async function fetchAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0; const pg = 1000;
  for (;;) { const { data, error } = await build(f, f + pg - 1); if (error) throw error; if (!data?.length) break; out = out.concat(data); if (data.length < pg) break; f += pg; }
  return out;
}

(async () => {
  const rows = await fetchAll<any>((f, t) => sb.from('facts')
    .select('id, subject_entity, object_text, observed_at, supersedes')
    .eq('workspace_id', WS).eq('predicate', 'score_total').range(f, t));
  console.log(`score_total fact rows: ${rows.length}`);

  // What the dispatcher reads: rows whose own `supersedes` is null.
  const dispatcherVal = new Map<string, number>();
  for (const r of rows) {
    if (r.supersedes !== null) continue;
    const v = Number(r.object_text);
    if (Number.isFinite(v)) dispatcherVal.set(r.subject_entity, v);
  }
  // Current: the row no other row points at (i.e. not superseded by anything).
  const supersededIds = new Set(rows.map((r) => r.supersedes).filter(Boolean));
  const currentVal = new Map<string, { v: number; at: string }>();
  for (const r of rows) {
    if (supersededIds.has(r.id)) continue;
    const v = Number(r.object_text);
    if (!Number.isFinite(v)) continue;
    const prev = currentVal.get(r.subject_entity);
    if (!prev || r.observed_at > prev.at) currentVal.set(r.subject_entity, { v, at: r.observed_at });
  }

  let same = 0, valueDiff = 0, tierDiff = 0, onlyOne = 0;
  const moves = new Map<string, number>();
  const examples: string[] = [];
  for (const [id, cur] of currentVal) {
    const disp = dispatcherVal.get(id);
    if (disp === undefined) { onlyOne++; continue; }
    if (Math.abs(disp - cur.v) < 1e-9) { same++; continue; }
    valueDiff++;
    const from = tier(disp), to = tier(cur.v);
    if (from !== to) {
      tierDiff++;
      const k = `${from} -> ${to}`;
      moves.set(k, (moves.get(k) ?? 0) + 1);
      if (examples.length < 10) examples.push(`${id.slice(0, 8)}  dispatcher reads ${disp.toFixed(2)} (${from}, every ${CADENCE[from]})  actual ${cur.v.toFixed(2)} (${to}, every ${CADENCE[to]})`);
    }
  }

  const total = currentVal.size;
  console.log(`\naccounts with a score_total: ${total}`);
  console.log(`  dispatcher value == current value : ${same} (${((same / total) * 100).toFixed(0)}%)`);
  console.log(`  value differs                     : ${valueDiff} (${((valueDiff / total) * 100).toFixed(0)}%)`);
  console.log(`  lands in a DIFFERENT research tier: ${tierDiff} (${((tierDiff / total) * 100).toFixed(0)}%)`);
  console.log(`  only one row present (no chain)   : ${onlyOne}`);
  console.log(`\ntier moves:`);
  for (const [k, v] of [...moves.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
  console.log(`\nexamples:`);
  for (const e of examples) console.log(`  ${e}`);

  // Names for the worst offenders: accounts the dispatcher thinks are cold but aren't.
  const names = new Map<string, string>();
  const wrongHot: Array<{ id: string; disp: number; cur: number }> = [];
  for (const [id, cur] of currentVal) {
    const disp = dispatcherVal.get(id);
    if (disp === undefined) continue;
    if (tier(disp) !== 'hot' && tier(cur.v) === 'hot') wrongHot.push({ id, disp, cur: cur.v });
  }
  wrongHot.sort((a, b) => b.cur - a.cur);
  const top = wrongHot.slice(0, 12);
  if (top.length) {
    const r = await sb.from('entities').select('id, name').in('id', top.map((x) => x.id));
    for (const e of r.data ?? []) names.set(e.id, e.name);
    console.log(`\nHOT accounts the dispatcher is treating as colder (researched every 7d or 30d instead of 24h): ${wrongHot.length}`);
    for (const x of top) console.log(`  ${(names.get(x.id) ?? x.id.slice(0, 8)).padEnd(28)} reads ${x.disp.toFixed(2)}  actual ${x.cur.toFixed(2)}`);
  }
})();
