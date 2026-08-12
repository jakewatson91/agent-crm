/**
 * What budget does the enricher actually need, and does budget even explain the
 * failures? Correlates successful output_tokens with the account's fact count.
 * Read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SINCE = new Date(Date.now() - 60 * 86400 * 1000).toISOString();
async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0;
  for (;;) { const { data, error } = await build(f, f + 999); if (error) throw error;
    if (!data?.length) break; out = out.concat(data as T[]); if (data.length < 1000) break; f += 1000; }
  return out;
}
const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p*s.length))]; };

(async () => {
  const ok = await pageAll<any>((f,t)=>sb.from('events').select('created_at,payload')
    .eq('action','agent_run_metrics').gte('created_at',SINCE).order('created_at').range(f,t));
  console.log(`agent_run_metrics rows in 60d: ${ok.length}`);
  const byBeh = new Map<string, {out:number[]; inp:number[]; ents:string[]}>();
  for (const r of ok) {
    const p = r.payload ?? {};
    const b = p.behavior ?? '?';
    if (!byBeh.has(b)) byBeh.set(b, {out:[],inp:[],ents:[]});
    const g = byBeh.get(b)!;
    if (typeof p.output_tokens === 'number') g.out.push(p.output_tokens);
    if (typeof p.input_tokens === 'number') g.inp.push(p.input_tokens);
    if (p.entity_id) g.ents.push(p.entity_id);
  }
  console.log('\n--- successful runs: output tokens used (the cap is 1200 for everything but drafter=3000) ---');
  console.log('behavior         n     p50    p90    p95    p99    max  | in p50    in max');
  for (const [b,g] of byBeh) {
    console.log(`${b.padEnd(15)}${String(g.out.length).padStart(5)} ${String(q(g.out,.5)).padStart(6)} ${String(q(g.out,.9)).padStart(6)} ${String(q(g.out,.95)).padStart(6)} ${String(q(g.out,.99)).padStart(6)} ${String(Math.max(0,...g.out)).padStart(6)}  | ${String(q(g.inp,.5)).padStart(7)} ${String(Math.max(0,...g.inp)).padStart(8)}`);
  }
  // how close to the cap do successful enricher runs get?
  const en = byBeh.get('enricher');
  if (en) {
    const cap = 1200;
    const near = en.out.filter(x=>x>=cap*0.9).length;
    console.log(`\nenricher runs at >=90% of the 1200 cap: ${near}/${en.out.length} (${((near/en.out.length)*100).toFixed(1)}%)`);
    console.log(`enricher runs that hit 1200 exactly:   ${en.out.filter(x=>x===cap).length}`);
    console.log(`enricher runs over 1200 (retry ran):   ${en.out.filter(x=>x>cap).length}`);
    const over = en.out.filter(x=>x>cap);
    if (over.length) console.log(`  their values: ${[...new Set(over)].sort((a,b)=>a-b).join(', ')}`);
  }
  // fact count vs output tokens, enricher only
  if (en?.ents.length) {
    const ids = [...new Set(en.ents)];
    const counts = new Map<string, number>();
    for (let i=0;i<ids.length;i+=100) {
      const rows = await pageAll<any>((f,t)=>sb.from('facts').select('subject_entity')
        .in('subject_entity', ids.slice(i,i+100)).is('supersedes',null).range(f,t));
      for (const r of rows) counts.set(r.subject_entity,(counts.get(r.subject_entity)??0)+1);
    }
    const buckets = new Map<string, number[]>();
    for (const r of ok) {
      const p = r.payload ?? {};
      if (p.behavior !== 'enricher' || typeof p.output_tokens !== 'number' || !p.entity_id) continue;
      const c = counts.get(p.entity_id) ?? 0;
      const b = c < 10 ? '00-09' : c < 25 ? '10-24' : c < 50 ? '25-49' : c < 90 ? '50-89' : '90+';
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b)!.push(p.output_tokens);
    }
    console.log('\n--- enricher output tokens by the account\'s current fact count ---');
    console.log('facts     n    p50   p90   p99   max');
    for (const b of ['00-09','10-24','25-49','50-89','90+']) {
      const xs = buckets.get(b) ?? [];
      if (!xs.length) { console.log(`${b.padEnd(9)}${String(0).padStart(4)}`); continue; }
      console.log(`${b.padEnd(9)}${String(xs.length).padStart(4)} ${String(q(xs,.5)).padStart(6)}${String(q(xs,.9)).padStart(6)}${String(q(xs,.99)).padStart(6)}${String(Math.max(...xs)).padStart(6)}`);
    }
  }
})();
