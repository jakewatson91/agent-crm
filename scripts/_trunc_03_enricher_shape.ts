/**
 * Would raising the enricher budget fix it? The failure payloads say the 4000-token
 * retry ALSO came back empty, which would make a bigger cap chase the problem.
 * Check that against the successful runs' real token use, and against fact count
 * per account -- the claim is that it hits the heaviest-researched accounts.
 * Read-only.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const SINCE = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
async function pageAll<T>(build: (f: number, t: number) => any): Promise<T[]> {
  let out: T[] = []; let f = 0;
  for (;;) { const { data, error } = await build(f, f + 999); if (error) throw error;
    if (!data?.length) break; out = out.concat(data as T[]); if (data.length < 1000) break; f += 1000; }
  return out;
}
const q = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(p*s.length))]; };

(async () => {
  // reason x message x day
  const fails = await pageAll<any>((f,t)=>sb.from('events').select('created_at,target_id,payload')
    .eq('action','agent_llm_failed').gte('created_at',SINCE).order('created_at').range(f,t));
  const combo = new Map<string, number>();
  for (const f of fails) {
    const p = f.payload ?? {};
    combo.set(`${p.behavior}|${p.reason}|${String(p.message ?? '').slice(0,40)}`, (combo.get(`${p.behavior}|${p.reason}|${String(p.message ?? '').slice(0,40)}`) ?? 0) + 1);
  }
  console.log('--- failures: behavior | reason | message ---');
  for (const [k,n] of [...combo.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(n).padStart(3)}x  ${k}`);

  // "Insufficient Balance" by day -- is it a window or ongoing?
  console.log('\n--- Insufficient Balance by day ---');
  const balByDay = new Map<string, number>();
  for (const f of fails) if (String(f.payload?.message ?? '').includes('Insufficient Balance')) balByDay.set(f.created_at.slice(0,10), (balByDay.get(f.created_at.slice(0,10)) ?? 0)+1);
  for (const [k,v] of [...balByDay.entries()].sort()) console.log(`  ${k}  ${v}`);

  // successful enricher runs: what do they actually spend?
  const ok = await pageAll<any>((f,t)=>sb.from('events').select('created_at,target_id,payload')
    .eq('action','agent_run_metrics').gte('created_at',SINCE).order('created_at').range(f,t));
  const byBeh = new Map<string, number[]>();
  const inByBeh = new Map<string, number[]>();
  for (const r of ok) {
    const p = r.payload ?? {};
    const b = p.behavior ?? p.agent ?? '?';
    if (!byBeh.has(b)) { byBeh.set(b, []); inByBeh.set(b, []); }
    if (typeof p.llm_output_tokens === 'number') byBeh.get(b)!.push(p.llm_output_tokens);
    if (typeof p.llm_input_tokens === 'number') inByBeh.get(b)!.push(p.llm_input_tokens);
  }
  console.log('\n--- successful runs: output tokens actually used ---');
  console.log('behavior       n     p50   p90   p99   max   | input p50  p99   max');
  for (const [b, xs] of byBeh) {
    const ins = inByBeh.get(b) ?? [];
    console.log(`${b.padEnd(13)} ${String(xs.length).padStart(5)} ${String(q(xs,.5)).padStart(6)}${String(q(xs,.9)).padStart(6)}${String(q(xs,.99)).padStart(6)}${String(Math.max(0,...xs)).padStart(6)}   | ${String(q(ins,.5)).padStart(8)}${String(q(ins,.99)).padStart(6)}${String(Math.max(0,...ins)).padStart(7)}`);
  }

  // do failures concentrate on fact-heavy accounts?
  const failEnts = [...new Set(fails.filter(f=>f.payload?.behavior==='enricher').map(f=>f.target_id).filter(Boolean))];
  const okEnts = [...new Set(ok.filter(r=>(r.payload?.behavior ?? r.payload?.agent)==='enricher').map(r=>r.target_id).filter(Boolean))];
  console.log(`\n--- fact load: ${failEnts.length} entities that failed vs ${okEnts.length} that succeeded ---`);
  async function factCounts(ids: string[]) {
    const out = new Map<string, number>();
    for (let i=0;i<ids.length;i+=100) {
      const rows = await pageAll<any>((f,t)=>sb.from('facts').select('subject_entity').in('subject_entity', ids.slice(i,i+100)).is('supersedes', null).range(f,t));
      for (const r of rows) out.set(r.subject_entity, (out.get(r.subject_entity) ?? 0)+1);
    }
    return out;
  }
  const fc = await factCounts(failEnts);
  const oc = await factCounts(okEnts.filter(e=>!failEnts.includes(e)).slice(0,300));
  const fv = failEnts.map(e=>fc.get(e) ?? 0);
  const ov = [...oc.values()];
  console.log(`failed entities   : n=${fv.length} p50=${q(fv,.5)} p90=${q(fv,.9)} max=${Math.max(0,...fv)}`);
  console.log(`succeeded (never failed): n=${ov.length} p50=${q(ov,.5)} p90=${q(ov,.9)} max=${Math.max(0,...ov)}`);
  const { data: names } = await sb.from('entities').select('id,name').in('id', failEnts.slice(0,20));
  console.log('\ntop failing entities by current fact count:');
  for (const [id, n] of [...fc.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10)) {
    console.log(`  ${String(n).padStart(4)} facts  ${names?.find((x:any)=>x.id===id)?.name ?? id.slice(0,8)}`);
  }
})();
